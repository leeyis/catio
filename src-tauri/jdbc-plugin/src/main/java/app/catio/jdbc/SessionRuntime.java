package app.catio.jdbc;

import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.SQLTimeoutException;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;

/** Runtime-only physical JDBC sessions and request-scoped cancellation. Never logs connection properties. */
final class SessionRuntime {
    static final class Session {
        final ReentrantLock operation=new ReentrantLock(true);
        volatile boolean closed;
        volatile boolean unmanagedTransaction;
        Connection connection;
        String connectionKey="";
    }
    record Context(long requestId,String sessionId,Session session) {}
    record ActiveStatement(String sessionId,Statement statement) {}
    private record EarlyCancel(String sessionId,long created) {}
    private static final Object registryLock=new Object();
    private static final Map<String,Session> sessions=new HashMap<>();
    // Retain closed IDs to reject delayed opens/queries. A bounded lifetime budget
    // asks the user to reconnect rather than dropping tombstones and reviving an old session.
    private static final Set<String> closedSessions=new HashSet<>();
    static final Map<Long,ActiveStatement> activeStatements=new ConcurrentHashMap<>();
    private static final Map<Long,EarlyCancel> earlyCancels=new ConcurrentHashMap<>();
    private static final ThreadLocal<Context> context=new ThreadLocal<>();
    private static final int MAX_LIVE=33, MAX_LIFETIME=8192, MAX_EARLY_CANCEL=256;

    static Session lookup(String id,boolean open) throws SQLException {
        if(!id.matches("[A-Za-z0-9_-]{0,128}"))throw new SQLException("Invalid JDBC session ID");
        synchronized(registryLock) {
            if(!id.isEmpty()&&closedSessions.contains(id))throw new SQLException("JDBC SQL session is closed");
            Session session=sessions.get(id);
            if(session==null) {
                if(!open&&!id.isEmpty())throw new SQLException("JDBC SQL session is closed or unknown");
                if(sessions.size()>=MAX_LIVE||closedSessions.size()>=MAX_LIFETIME)throw new SQLException("JDBC session limit reached; reconnect the parent connection");
                session=new Session();sessions.put(id,session);
            } else if(open&&!id.isEmpty())throw new SQLException("JDBC SQL session already exists");
            return session;
        }
    }
    static void enter(long requestId,String sessionId,Session session) throws SQLException {
        context.set(new Context(requestId,sessionId,session));
        if(session.closed)throw new SQLException("JDBC SQL session is closed");
        checkCancelled();
    }
    static Context current() {Context current=context.get();if(current==null)throw new IllegalStateException("No JDBC request context");return current;}
    static void leave() {
        Context current=context.get();
        if(current!=null){activeStatements.remove(current.requestId());earlyCancels.remove(current.requestId());}
        context.remove();
    }
    static void checkCancelled() throws SQLException {
        Context current=current();EarlyCancel early=earlyCancels.get(current.requestId());
        if(current.session().closed || (early!=null&&early.sessionId().equals(current.sessionId()))) {
            throw new SQLTimeoutException("JDBC query cancelled","57014");
        }
    }
    static void track(Statement statement) throws SQLException {
        Context current=current();
        activeStatements.put(current.requestId(),new ActiveStatement(current.sessionId(),statement));
        checkCancelled();
    }
    static boolean cancel(long requestId,String sessionId) throws SQLException {
        ActiveStatement active=activeStatements.get(requestId);
        if(active!=null) {
            if(!active.sessionId().equals(sessionId))throw new SQLException("Cancellation belongs to another SQL session");
            earlyCancels.put(requestId,new EarlyCancel(sessionId,System.nanoTime()));
            active.statement().cancel();return true;
        }
        long now=System.nanoTime();earlyCancels.entrySet().removeIf(e->now-e.getValue().created()>60_000_000_000L);
        if(earlyCancels.size()>=MAX_EARLY_CANCEL)throw new SQLException("Too many pending JDBC cancellations");
        earlyCancels.put(requestId,new EarlyCancel(sessionId,now));return false;
    }
    static void close(String id) {
        Session session;
        synchronized(registryLock) {
            session=sessions.remove(id);
            if(!id.isEmpty()&&closedSessions.size()<MAX_LIFETIME+MAX_LIVE)closedSessions.add(id);
            if(session!=null)session.closed=true;
        }
        for(ActiveStatement active:activeStatements.values())if(active.sessionId().equals(id)) {
            try{active.statement().cancel();}catch(Throwable ignored){}
        }
        if(session!=null)closeConnection(session);
    }
    static void closeConnection(Session session) {
        Connection connection;
        synchronized(session){connection=session.connection;session.connection=null;session.connectionKey="";}
        if(connection!=null) {
            try{if(!connection.getAutoCommit())connection.rollback();}catch(Throwable ignored){}
            try{connection.close();}catch(Throwable ignored){}
        }
    }
    static void closeAll() {
        List<String> ids; synchronized(registryLock){ids=new ArrayList<>(sessions.keySet());}
        for(String id:ids)close(id);
        synchronized(registryLock){closedSessions.clear();}
        earlyCancels.clear();
    }
    static void failCurrent() {close(current().sessionId());}
}
