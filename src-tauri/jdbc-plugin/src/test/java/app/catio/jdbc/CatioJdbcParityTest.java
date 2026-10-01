package app.catio.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import java.lang.reflect.Method;
import java.util.UUID;
import static org.junit.jupiter.api.Assertions.*;

class CatioJdbcParityTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private ObjectNode connection;
    private Method handle;

    @BeforeEach void setup() throws Exception {
        handle = CatioJdbcPlugin.class.getDeclaredMethod("handleLine", String.class);
        handle.setAccessible(true);
        connection = JSON.createObjectNode();
        connection.put("connection_string", "jdbc:h2:mem:" + UUID.randomUUID());
        connection.put("jdbc_driver_class", "org.h2.Driver");
        connection.put("username", "sa"); connection.put("password", "");
        call("connect", JSON.createObjectNode());
    }
    @AfterEach void close() throws Exception { call("close", JSON.createObjectNode()); }
    private ObjectNode response(String method, ObjectNode args) throws Exception {
        args.set("connection", connection);
        ObjectNode request = JSON.createObjectNode();
        request.put("id", 1); request.put("method", method); request.set("params", args);
        return (ObjectNode) handle.invoke(null, request.toString());
    }
    private JsonNode call(String method, ObjectNode args) throws Exception {
        ObjectNode reply = response(method, args);
        assertFalse(reply.has("error"), () -> reply.path("error").toString());
        return reply.path("result");
    }
    private JsonNode sql(String sql) throws Exception {
        return call("executeQuery", JSON.createObjectNode().put("sql", sql).put("maxRows", 100));
    }

    @Test void jdbcValuesAndTypesAreLossless() throws Exception {
        JsonNode result = sql("SELECT CAST(9007199254740993 AS BIGINT) AS ID, CAST(12345678901234567890.123456789012 AS DECIMAL(38,12)) AS AMOUNT");
        assertTrue(result.path("rows").get(0).get(0).isTextual(), "unsafe integer must be a string");
        assertEquals("9007199254740993", result.path("rows").get(0).get(0).asText());
        assertEquals("12345678901234567890.123456789012", result.path("rows").get(0).get(1).asText());
        assertEquals(2, result.path("column_types").size());
    }

    @Test void jdbcCursorPagesWithoutShippingTheSkippedRows() throws Exception {
        ObjectNode args = JSON.createObjectNode().put("sql", "SELECT X FROM SYSTEM_RANGE(1,205)").put("maxRows", 100).put("offsetRows", 100);
        JsonNode page = call("executeQuery", args);
        assertEquals(100, page.path("rows").size());
        assertEquals(101, page.path("rows").get(0).get(0).asInt());
        assertTrue(page.path("truncated").asBoolean());
        args.put("offsetRows", 200);
        page = call("executeQuery", args);
        assertEquals(5, page.path("rows").size());
        assertFalse(page.path("truncated").asBoolean());
    }

    @Test void exposesCompositeIndexesAndForeignKeys() throws Exception {
        sql("CREATE TABLE P(ID INT PRIMARY KEY)");
        sql("CREATE TABLE C(ID INT PRIMARY KEY, PID INT, LABEL VARCHAR, CONSTRAINT FK_PARENT FOREIGN KEY(PID) REFERENCES P(ID) ON DELETE CASCADE)");
        sql("CREATE UNIQUE INDEX IX_LABEL_PID ON C(LABEL, PID)");
        ObjectNode params = JSON.createObjectNode().put("schema", "PUBLIC").put("table", "C");
        JsonNode indexes = call("getIndexes", params.deepCopy());
        boolean found = false;
        for (JsonNode index : indexes) if (index.path("name").asText().equals("IX_LABEL_PID")) {
            found = true; assertEquals("LABEL, PID", index.path("columns").asText()); assertTrue(index.path("unique").asBoolean());
        }
        assertTrue(found, "composite index must be present");
        JsonNode keys = call("getForeignKeys", params.deepCopy());
        assertEquals(1, keys.size());
        assertEquals("FK_PARENT", keys.get(0).path("constraint_name").asText());
        assertEquals("CASCADE", keys.get(0).path("on_delete").asText());
        assertEquals("PUBLIC.P.ID", keys.get(0).path("references").asText());
    }

    @Test void failedTransactionCanRollbackWithoutLosingOriginalRows() throws Exception {
        assertTrue(call("testConnection", JSON.createObjectNode()).path("transactions").asBoolean());
        sql("CREATE TABLE T(ID INT PRIMARY KEY, V VARCHAR)");
        sql("INSERT INTO T VALUES(1,'original')");
        call("beginTransaction", JSON.createObjectNode());
        call("executeUpdate", JSON.createObjectNode().put("sql", "UPDATE T SET V='changed' WHERE ID=1"));
        assertTrue(response("executeUpdate", JSON.createObjectNode().put("sql", "INSERT INTO T VALUES(1,'duplicate')")).has("error"));
        call("rollbackTransaction", JSON.createObjectNode());
        assertEquals("original", sql("SELECT V FROM T WHERE ID=1").path("rows").get(0).get(0).asText());
        call("beginTransaction", JSON.createObjectNode());
        call("executeUpdate", JSON.createObjectNode().put("sql", "INSERT INTO T VALUES(2,'committed')"));
        call("commitTransaction", JSON.createObjectNode());
        assertEquals(2, sql("SELECT COUNT(*) FROM T").path("rows").get(0).get(0).asInt());
    }
}
