package app.catio.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import java.lang.reflect.Method;
import java.lang.reflect.Field;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import static org.junit.jupiter.api.Assertions.*;

class CatioJdbcSessionTest {
    private static final ObjectMapper JSON=new ObjectMapper();
    private static final AtomicLong IDS=new AtomicLong();
    private ObjectNode connection;
    private Method handler;
    @BeforeEach void setup() throws Exception {
        handler=CatioJdbcPlugin.class.getDeclaredMethod("handleLine",String.class);handler.setAccessible(true);
        connection=JSON.createObjectNode().put("connection_string","jdbc:h2:mem:"+UUID.randomUUID()+";DB_CLOSE_DELAY=-1")
            .put("jdbc_driver_class","org.h2.Driver").put("username","sa").put("password","");
        call("","connect",JSON.createObjectNode());
    }
    @AfterEach void cleanup() throws Exception {call("","close",JSON.createObjectNode());}
    private ObjectNode response(long id,String session,String method,ObjectNode params) throws Exception {
        params.set("connection",connection);params.put("sessionId",session);
        ObjectNode request=JSON.createObjectNode().put("id",id).put("method",method);request.set("params",params);
        return (ObjectNode)handler.invoke(null,request.toString());
    }
    private JsonNode call(String session,String method,ObjectNode params) throws Exception {
        ObjectNode result=response(IDS.incrementAndGet(),session,method,params);
        assertFalse(result.has("error"),()->result.path("error").toString());return result.path("result");
    }
    private JsonNode sql(String session,String sql) throws Exception {
        return call(session,"executeQuery",JSON.createObjectNode().put("sql",sql).put("maxRows",100));
    }
    @Test void sessionsShareH2DatabaseButNotTransactionsOrTemporaryTables() throws Exception {
        sql("","CREATE TABLE DATA(ID INT PRIMARY KEY)");
        call("a","openSession",JSON.createObjectNode());call("b","openSession",JSON.createObjectNode());
        sql("a","CREATE LOCAL TEMPORARY TABLE LOCAL_ONLY(ID INT)");
        assertTrue(response(IDS.incrementAndGet(),"b","executeQuery",JSON.createObjectNode().put("sql","SELECT * FROM LOCAL_ONLY")).has("error"));
        call("a","beginTransaction",JSON.createObjectNode());sql("a","INSERT INTO DATA VALUES(1)");
        assertEquals(0,sql("b","SELECT COUNT(*) FROM DATA").path("rows").get(0).get(0).asInt());
        assertFalse(call("a","sessionStatus",JSON.createObjectNode()).path("autoCommit").asBoolean());
        assertTrue(call("b","sessionStatus",JSON.createObjectNode()).path("autoCommit").asBoolean());
        call("a","closeSession",JSON.createObjectNode());
        assertEquals(0,sql("b","SELECT COUNT(*) FROM DATA").path("rows").get(0).get(0).asInt());
        assertTrue(response(IDS.incrementAndGet(),"a","executeQuery",JSON.createObjectNode().put("sql","SELECT 1")).has("error"),"closed session must not auto-reopen");
        call("b","beginTransaction",JSON.createObjectNode());sql("b","INSERT INTO DATA VALUES(2)");
        call("b","commitTransaction",JSON.createObjectNode());
        assertEquals(2,sql("","SELECT ID FROM DATA").path("rows").get(0).get(0).asInt());
    }
    @Test void earlyCancellationPreventsAWrite() throws Exception {
        call("a","openSession",JSON.createObjectNode());sql("a","CREATE TABLE STOPPED(ID INT)");
        long request=IDS.incrementAndGet();
        call("a","cancelRequest",JSON.createObjectNode().put("targetRequestId",request));
        assertTrue(response(request,"a","executeQuery",JSON.createObjectNode().put("sql","INSERT INTO STOPPED VALUES(1)")).has("error"));
        assertEquals(0,sql("a","SELECT COUNT(*) FROM STOPPED").path("rows").get(0).get(0).asInt());
    }
    @Test void closeBeforeOpenCannotReviveAnAbandonedSession() throws Exception {
        call("late","closeSession",JSON.createObjectNode());
        assertTrue(response(IDS.incrementAndGet(),"late","openSession",JSON.createObjectNode()).has("error"));
        assertEquals(1,sql("","SELECT 1").path("rows").get(0).get(0).asInt());
    }
    @Test void closingRunningSessionTerminatesOnlyThatConnection() throws Exception {
        call("a","openSession",JSON.createObjectNode());call("b","openSession",JSON.createObjectNode());
        long request=IDS.incrementAndGet();ExecutorService executor=Executors.newSingleThreadExecutor();
        try {
            Future<ObjectNode> running=executor.submit(()->response(request,"a","executeQuery",JSON.createObjectNode()
                .put("sql","SELECT SUM(X) FROM SYSTEM_RANGE(1,1000000000)").put("maxRows",1)));
            Field field=CatioJdbcPlugin.class.getDeclaredField("activeStatements");field.setAccessible(true);
            Map<?,?> active=(Map<?,?>)field.get(null);long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
            while(!active.containsKey(request)&&System.nanoTime()<deadline)Thread.sleep(5);
            assertTrue(active.containsKey(request));
            call("a","closeSession",JSON.createObjectNode());
            assertTrue(running.get(5,TimeUnit.SECONDS).has("error"));
            assertEquals(8,sql("b","SELECT 8").path("rows").get(0).get(0).asInt());
        } finally {executor.shutdownNow();}
    }
    @Test void cancellationIsRequestScopedAndDoesNotStopAnotherSession() throws Exception {
        call("a","openSession",JSON.createObjectNode());call("b","openSession",JSON.createObjectNode());
        long request=IDS.incrementAndGet();
        ExecutorService executor=Executors.newSingleThreadExecutor();
        try {
            Future<ObjectNode> running=executor.submit(()->response(request,"a","executeQuery",JSON.createObjectNode()
                .put("sql","SELECT SUM(X) FROM SYSTEM_RANGE(1,1000000000)").put("maxRows",1)));
            Field field=CatioJdbcPlugin.class.getDeclaredField("activeStatements");field.setAccessible(true);
            Map<?,?> active=(Map<?,?>)field.get(null);
            long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
            while(!active.containsKey(request)&&System.nanoTime()<deadline)Thread.sleep(5);
            assertTrue(active.containsKey(request),"long query never became active");
            assertTrue(response(IDS.incrementAndGet(),"b","cancelRequest",JSON.createObjectNode().put("targetRequestId",request)).has("error"));
            call("a","cancelRequest",JSON.createObjectNode().put("targetRequestId",request));
            ObjectNode result=running.get(5,TimeUnit.SECONDS);assertTrue(result.has("error"));
            assertEquals(7,sql("b","SELECT 7").path("rows").get(0).get(0).asInt());
        } finally {executor.shutdownNow();}
    }
}
