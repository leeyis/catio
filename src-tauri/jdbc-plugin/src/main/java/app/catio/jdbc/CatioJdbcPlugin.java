package app.catio.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.URLEncoder;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.TreeMap;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.Date;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.DriverPropertyInfo;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.sql.Statement;
import java.sql.Time;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.temporal.TemporalAccessor;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Properties;
import java.util.ServiceLoader;
import java.util.Set;
import java.util.logging.Logger;

public final class CatioJdbcPlugin {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final int MAX_ROWS = 10_000;
    private static final JdbcDriverQuirks DEFAULT_QUIRKS = new JdbcDriverQuirks(false, false, false, false, false);
    private static final JdbcDriverQuirks USE_CATALOG_QUIRKS = new JdbcDriverQuirks(false, false, false, true, false);
    private static final JdbcDriverQuirks KINGBASE_QUIRKS = new JdbcDriverQuirks(false, false, false, false, true);
    private static final JdbcDriverQuirks YASHAN_QUIRKS = new JdbcDriverQuirks(true, true, false, false, false);
    private static final JdbcDriverQuirks IRIS_QUIRKS = new JdbcDriverQuirks(true, false, true, false, false);
    private static final JdbcDriverQuirks ORACLE_QUIRKS = new JdbcDriverQuirks(false, true, false, false, false);
    private static final List<JdbcDriverQuirkRule> DRIVER_QUIRK_RULES = List.of(
        new JdbcDriverQuirkRule("jdbc:mysql:", USE_CATALOG_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:mariadb:", USE_CATALOG_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:starrocks:", USE_CATALOG_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:doris:", USE_CATALOG_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:hive2:", USE_CATALOG_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:kingbase", KINGBASE_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:yasdb:", YASHAN_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:iris:", IRIS_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:oracle:", ORACLE_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:dm:", ORACLE_QUIRKS)
    );
    private static String registeredDriverKey = "";
    private static final Map<Long,SessionRuntime.ActiveStatement> activeStatements = SessionRuntime.activeStatements;

    record JdbcDriverQuirks(
        boolean skipExecutionContext,
        boolean useOracleMetadata,
        boolean caseInsensitiveSchemaMetadata,
        boolean useCatalogFallbackSql,
        boolean ignoreCatalogForSchemaMetadata
    ) {
    }

    private record JdbcDriverQuirkRule(String urlPrefix, JdbcDriverQuirks quirks) {
    }

    private CatioJdbcPlugin() {
    }

    public static void main(String[] args) throws Exception {
        java.util.concurrent.ThreadFactory daemon = task -> { Thread thread=new Thread(task,"catio-jdbc-request");thread.setDaemon(true);return thread; };
        java.util.concurrent.ExecutorService workers=new java.util.concurrent.ThreadPoolExecutor(8,8,0L,java.util.concurrent.TimeUnit.MILLISECONDS,
            new java.util.concurrent.ArrayBlockingQueue<>(128),daemon,new java.util.concurrent.ThreadPoolExecutor.AbortPolicy());
        java.util.concurrent.ExecutorService controls=new java.util.concurrent.ThreadPoolExecutor(2,2,0L,java.util.concurrent.TimeUnit.MILLISECONDS,
            new java.util.concurrent.ArrayBlockingQueue<>(64),daemon,new java.util.concurrent.ThreadPoolExecutor.AbortPolicy());
        try (BufferedReader reader=new BufferedReader(new InputStreamReader(System.in,StandardCharsets.UTF_8));
             BufferedWriter writer=new BufferedWriter(new OutputStreamWriter(System.out,StandardCharsets.UTF_8))) {
            String line;
            while((line=reader.readLine())!=null) {
                if(line.isBlank())continue;
                final String request=line;
                JsonNode header=MAPPER.readTree(request);
                String method=header.path("method").asText();
                if("close".equals(method)){writeResponse(writer,handleLine(request));break;}
                java.util.concurrent.ExecutorService executor=Set.of("cancelRequest","closeSession").contains(method)?controls:workers;
                try { executor.execute(()->{
                    try {writeResponse(writer,handleLine(request));}
                    catch(Exception error){ // never echo the request: it contains credentials
                        ObjectNode response=MAPPER.createObjectNode();response.set("id",header.path("id"));
                        response.set("error",MAPPER.createObjectNode().put("message","JDBC request processing failed"));
                        try{writeResponse(writer,response);}catch(Exception ignored){}
                    }
                }); } catch(java.util.concurrent.RejectedExecutionException busy) {
                    ObjectNode response=MAPPER.createObjectNode();response.set("id",header.path("id"));
                    response.set("error",MAPPER.createObjectNode().put("message","JDBC request queue is full"));writeResponse(writer,response);
                }
            }
        } finally {workers.shutdownNow();controls.shutdownNow();closeSharedConnection();}
    }
    private static void writeResponse(BufferedWriter writer,ObjectNode response) throws Exception {
        synchronized(writer){writer.write(MAPPER.writeValueAsString(response));writer.newLine();writer.flush();}
    }
    private static ObjectNode handleLine(String line) throws Exception {
        JsonNode request=MAPPER.readTree(line),id=request.path("id");
        ObjectNode response=MAPPER.createObjectNode();response.set("id",id.isMissingNode()?MAPPER.getNodeFactory().numberNode(1):id);
        String method=request.path("method").asText(),sessionId=request.path("params").path("sessionId").asText("");
        SessionRuntime.Session session=null;boolean locked=false;
        try {
            if(method.isBlank())throw new IllegalArgumentException("JDBC method required");
            JsonNode params=request.path("params"),connection=params.path("connection");
            if("close".equals(method)){closeSharedConnection();response.set("result",MAPPER.createObjectNode().put("ok",true));response.put("_dbx_close",true);return response;}
            if("cancelRequest".equals(method)) {
                long target=params.path("targetRequestId").asLong(-1);if(target<1)throw new IllegalArgumentException("Invalid cancellation request ID");
                boolean active=SessionRuntime.cancel(target,sessionId);
                response.set("result",MAPPER.createObjectNode().put("requested",true).put("active",active));return response;
            }
            if("closeSession".equals(method)){SessionRuntime.close(sessionId);response.set("result",MAPPER.createObjectNode().put("ok",true));return response;}
            session=SessionRuntime.lookup(sessionId,"openSession".equals(method));
            session.operation.lockInterruptibly();locked=true;
            SessionRuntime.enter(id.asLong(1),sessionId,session);
            registerDrivers(connection);
            response.set("result",handle(method,params,connection));
        } catch(Throwable error) {
            if("openSession".equals(method))SessionRuntime.close(sessionId);
            ObjectNode message=MAPPER.createObjectNode();message.put("message",error.getMessage()==null?error.toString():error.getMessage());
            if(error instanceof SQLException sqlError)message.put("sql_state",sqlError.getSQLState());
            response.set("error",message);
        } finally {SessionRuntime.leave();if(locked)session.operation.unlock();}
        return response;
    }

    private static JsonNode handle(String method, JsonNode params, JsonNode connection) throws Exception {
        return switch (method) {
            case "testConnection", "connect", "openSession" -> {
                Connection conn = openConnection(connection);
                ObjectNode result = MAPPER.createObjectNode();
                result.put("ok", true);
                result.put("query_sessions",true);
                // Report a human-readable server version so catio's test() can
                // surface it (mirrors the native drivers' SELECT version()).
                try {
                    DatabaseMetaData md = conn.getMetaData();
                    result.put("transactions", md.supportsTransactions());
                    result.put("er", md.supportsIntegrityEnhancementFacility());
                    result.put("writable", !conn.isReadOnly());
                    String product = md.getDatabaseProductName();
                    String version = md.getDatabaseProductVersion();
                    result.put("version", ((product == null ? "" : product) + " "
                        + (version == null ? "" : version)).trim());
                } catch (Throwable ignored) {
                    // best-effort: some drivers reject getMetaData pre-query, and a
                    // few (e.g. 达梦/DM) can throw an Error here — never let reading
                    // the version number fail the connection itself.
                }
                yield result;
            }
            case "getExecutionContext" -> {
                Connection conn=openConnection(connection);String schema=null,catalog=null;
                try{schema=conn.getSchema();}catch(Throwable ignored){}
                try{catalog=conn.getCatalog();}catch(Throwable ignored){}
                if((schema==null||schema.isBlank())&&driverQuirks(connection).useOracleMetadata()) {
                    try(Statement statement=conn.createStatement();ResultSet rows=statement.executeQuery("SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL")) {
                        if(rows.next())schema=rows.getString(1);
                    }catch(SQLException ignored){}
                }
                String preferred=driverQuirks(connection).useCatalogFallbackSql()?catalog:(schema==null||schema.isBlank()?catalog:schema);
                yield MAPPER.createObjectNode().put("schema",schema).put("catalog",catalog).put("default_namespace",preferred);
            }
            case "sessionStatus" -> {
                Connection conn=openConnection(connection);
                boolean auto=conn.getAutoCommit();
                yield MAPPER.createObjectNode().put("autoCommit",auto).put("transactionState",!auto?"manual":SessionRuntime.current().session().unmanagedTransaction?"unknown":"idle");
            }
            case "executeQuery" -> executeQuery(
                connection,
                requireText(params, "sql"),
                optionalText(params, "database"),
                optionalText(params, "schema"),
                positiveInt(params, "maxRows", MAX_ROWS),
                nonNegativeInt(params, "fetchSize", 0),
                nonNegativeInt(params, "timeoutSecs", -1),
                nonNegativeInt(params, "offsetRows", 0)
            );
            case "beginTransaction" -> beginTransaction(connection);
            case "commitTransaction" -> finishTransaction(connection, true);
            case "rollbackTransaction" -> finishTransaction(connection, false);
            case "executeUpdate" -> executeUpdate(connection, requireText(params, "sql"));
            case "getIndexes" -> getIndexes(connection, optionalText(params, "database"), optionalText(params, "schema"), requireText(params, "table"));
            case "getForeignKeys" -> getForeignKeys(connection, optionalText(params, "database"), optionalText(params, "schema"), requireText(params, "table"));
            case "listDatabases" -> listDatabases(connection);
            case "listSchemas" -> listSchemas(connection, optionalText(params, "database"));
            case "listTables" -> listTables(connection, optionalText(params, "database"), optionalText(params, "schema"));
            case "listObjects", "list_objects" -> listObjects(
                connection,
                optionalText(params, "database"),
                optionalText(params, "schema")
            );
            case "getObjectSource", "get_object_source" -> getObjectSource(
                connection,
                optionalText(params, "database"),
                optionalText(params, "schema"),
                requireText(params, "name"),
                requireText(params, "object_type")
            );
            case "getColumns" -> getColumns(
                connection,
                optionalText(params, "database"),
                optionalText(params, "schema"),
                requireText(params, "table")
            );
            default -> throw new IllegalArgumentException("Unsupported JDBC plugin method: " + method);
        };
    }

    private static synchronized void registerDrivers(JsonNode connection) throws Exception {
        String driverKey = driverKey(connection);
        if (driverKey.equals(registeredDriverKey)) {
            return;
        }
        List<URL> urls = new ArrayList<>();
        JsonNode paths = connection.path("jdbc_driver_paths");
        if (paths.isArray()) {
            for (JsonNode path : paths) {
                String value = path.asText("").trim();
                if (!value.isEmpty()) {
                    urls.add(expandHome(value).toUri().toURL());
                }
            }
        }

        ClassLoader loader = urls.isEmpty()
            ? Thread.currentThread().getContextClassLoader()
            : new URLClassLoader(urls.toArray(URL[]::new), CatioJdbcPlugin.class.getClassLoader());
        Thread.currentThread().setContextClassLoader(loader);

        String driverClass = optionalText(connection, "jdbc_driver_class");
        if (driverClass != null) {
            Driver driver = (Driver) Class.forName(driverClass, true, loader).getDeclaredConstructor().newInstance();
            DriverManager.registerDriver(new DriverShim(driver));
            registeredDriverKey = driverKey;
            return;
        }

        boolean loaded = false;
        for (Driver driver : ServiceLoader.load(Driver.class, loader)) {
            DriverManager.registerDriver(new DriverShim(driver));
            loaded = true;
        }
        if (!loaded && !urls.isEmpty()) {
            throw new IllegalArgumentException("No JDBC driver was discovered. Enter the driver class name for this JAR.");
        }
        registeredDriverKey = driverKey;
    }

    private static Connection openConnection(JsonNode connection) throws SQLException {
        String url = jdbcUrl(connection);
        if (url == null) {
            throw new IllegalArgumentException("JDBC URL is required.");
        }
        String key = connectionKey(connection);
        SessionRuntime.Session session=SessionRuntime.current().session();
        synchronized(session) {
            if(session.closed)throw new SQLException("JDBC SQL session is closed");
            if(session.connection!=null&&key.equals(session.connectionKey)&&!session.connection.isClosed())return session.connection;
        }
        SessionRuntime.closeConnection(session);

        Properties properties = new Properties();
        String username = optionalText(connection, "username");
        String password = optionalText(connection, "password");
        if (username != null) {
            properties.setProperty("user", username);
        }
        if (password != null) {
            properties.setProperty("password", password);
        }
        applyConnectTimeout(connection, properties);
        if (isOracleUrl(url)) {
            applyOracleProperties(connection, properties);
        }
        Connection opened=DriverManager.getConnection(url,properties);
        synchronized(session) {
            if(session.closed){opened.close();throw new SQLException("JDBC SQL session closed while connecting");}
            session.connection=opened;session.connectionKey=key;
        }
        return opened;
    }

    private static void applyConnectTimeout(JsonNode connection, Properties properties) {
        int connectTimeoutSecs = positiveInt(connection, "connect_timeout_secs", 30);
        DriverManager.setLoginTimeout(connectTimeoutSecs);
        String value = Integer.toString(connectTimeoutSecs);
        properties.putIfAbsent("loginTimeout", value);
        properties.putIfAbsent("connectTimeout", value);
    }

    private static void applyOracleProperties(JsonNode connection, Properties properties) {
        properties.putIfAbsent("remarksReporting", "false");
        properties.putIfAbsent("restrictGetTables", "true");
        properties.putIfAbsent("includeSynonyms", "false");
        properties.putIfAbsent("oracle.jdbc.defaultRowPrefetch", "100");
        if (connection.path("sysdba").asBoolean(false)) {
            properties.putIfAbsent("internal_logon", "sysdba");
        }
    }

    private static JsonNode executeQuery(
        JsonNode connection,
        String sql,
        String database,
        String schema,
        int maxRows,
        int fetchSize,
        int timeoutSecs,
        int offsetRows
    ) throws SQLException {
        long start = System.nanoTime();
        Connection conn = openConnection(connection);
        boolean transactionSql=mayChangeTransactionMode(sql);
        if(transactionSql)SessionRuntime.current().session().unmanagedTransaction=true;
        else applyExecutionContext(connection, conn, database, schema);
        try (Statement statement = conn.createStatement()) {
            SessionRuntime.track(statement);
            int window = (int) Math.min(Integer.MAX_VALUE - 1L, (long) maxRows + offsetRows);
            applyStatementOptions(statement, window, fetchSize, timeoutSecs);
            SessionRuntime.checkCancelled();
            boolean hasResultSet = statement.execute(trimStatementSql(sql));
            ObjectNode result = MAPPER.createObjectNode();
            ArrayNode columns = MAPPER.createArrayNode();
            ArrayNode columnTypes = MAPPER.createArrayNode();
            ArrayNode rows = MAPPER.createArrayNode();
            boolean truncated = false;

            if (hasResultSet) {
                try (ResultSet rs = statement.getResultSet()) {
                    ResultSetMetaData meta = rs.getMetaData();
                    int columnCount = meta.getColumnCount();
                    for (int i = 1; i <= columnCount; i++) {
                        String label = meta.getColumnLabel(i);
                        columns.add(label == null || label.isBlank() ? meta.getColumnName(i) : label);
                        columnTypes.add(meta.getColumnTypeName(i));
                    }
                    int skipped = 0;
                    while (rs.next()) {
                        if (skipped < offsetRows) { skipped++; continue; }
                        if (rows.size() >= maxRows) {
                            truncated = true;
                            break;
                        }
                        ArrayNode row = MAPPER.createArrayNode();
                        for (int i = 1; i <= columnCount; i++) {
                            row.add(MAPPER.valueToTree(readValue(rs, meta, i)));
                        }
                        rows.add(row);
                    }
                }
            }

            result.set("columns", columns);
            result.set("column_types", columnTypes);
            result.set("rows", rows);
            result.put("affected_rows", hasResultSet ? 0 : Math.max(statement.getUpdateCount(), 0));
            result.put("execution_time_ms", (System.nanoTime() - start) / 1_000_000);
            result.put("truncated", truncated);
            return result;
        }
    }

    private static boolean mayChangeTransactionMode(String sql) {
        String text=sql.stripLeading();
        while(text.startsWith("--")||text.startsWith("/*")) {
            if(text.startsWith("--")){int end=text.indexOf('\n');if(end<0)return false;text=text.substring(end+1).stripLeading();}
            else {int end=text.indexOf("*/",2);if(end<0)return true;text=text.substring(end+2).stripLeading();}
        }
        return text.matches("(?is)^(BEGIN|START\\s+TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|CALL|EXEC|EXECUTE|DECLARE|DO|SET\\s+(AUTO|IMPLICIT)_?COMMIT|SET\\s+IMPLICIT_TRANSACTIONS)\\b.*");
    }

    private static JsonNode beginTransaction(JsonNode connection) throws SQLException {
        Connection conn = openConnection(connection);
        if (!conn.getMetaData().supportsTransactions()) throw new SQLException("Transactions are not supported by this JDBC driver");
        if (!conn.getAutoCommit() || SessionRuntime.current().session().unmanagedTransaction) throw new SQLException("A JDBC transaction is active or its state is unknown");
        conn.setAutoCommit(false);
        SessionRuntime.current().session().unmanagedTransaction=false;
        return MAPPER.createObjectNode().put("ok", true);
    }

    private static JsonNode finishTransaction(JsonNode connection, boolean commit) throws SQLException {
        Connection conn = openConnection(connection);
        if (conn.getAutoCommit()) {
            if(!commit && SessionRuntime.current().session().unmanagedTransaction) {
                try(Statement statement=conn.createStatement()){statement.execute("ROLLBACK");}
                SessionRuntime.current().session().unmanagedTransaction=false;
                return MAPPER.createObjectNode().put("ok",true);
            }
            throw new SQLException("No JDBC transaction is active");
        }
        try {
            if (commit) conn.commit(); else conn.rollback();
        } catch (SQLException failure) {
            // Never switch auto-commit back on after a failed rollback: some drivers
            // would commit outstanding work. Close the unusable connection instead.
            try { conn.rollback(); } catch (SQLException rollbackFailure) {
                SessionRuntime.failCurrent(); throw failure;
            }
            conn.setAutoCommit(true);
            throw failure;
        }
        conn.setAutoCommit(true);
        SessionRuntime.current().session().unmanagedTransaction=false;
        return MAPPER.createObjectNode().put("ok", true);
    }

    private static JsonNode executeUpdate(JsonNode connection, String sql) throws SQLException {
        Connection conn = openConnection(connection);
        if (conn.getAutoCommit()) throw new SQLException("Batch update requires an active transaction");
        try (Statement statement = conn.createStatement()) {
            SessionRuntime.track(statement);SessionRuntime.checkCancelled();
            return MAPPER.createObjectNode().put("affected_rows", Math.max(0, statement.executeUpdate(trimStatementSql(sql))));
        }
    }

    private static JsonNode getIndexes(JsonNode connection, String database, String schema, String table) throws SQLException {
        Connection conn = openConnection(connection);
        DatabaseMetaData meta = conn.getMetaData();
        JdbcDriverQuirks quirks = driverQuirks(connection);
        String catalog = metadataCatalog(database, quirks);
        String namespace = resolveSchemaPattern(meta, database, schema, quirks);
        ArrayNode result = indexes(meta, catalog, namespace, table);
        return result.isEmpty() && catalog != null ? indexes(meta, null, namespace, table) : result;
    }

    private static ArrayNode indexes(DatabaseMetaData meta, String catalog, String schema, String table) throws SQLException {
        Map<String, ObjectNode> indexes = new LinkedHashMap<>();
        Map<String, TreeMap<Integer, String>> columns = new LinkedHashMap<>();
        try (ResultSet rs = meta.getIndexInfo(catalog, schema, table, false, false)) {
            while (rs.next()) {
                String name = rs.getString("INDEX_NAME"), column = rs.getString("COLUMN_NAME");
                if (name == null || column == null || rs.getShort("TYPE") == DatabaseMetaData.tableIndexStatistic) continue;
                ObjectNode item = indexes.computeIfAbsent(name, k -> MAPPER.createObjectNode().put("name", k));
                item.put("unique", !rs.getBoolean("NON_UNIQUE"));
                item.put("method", rs.getShort("TYPE") == DatabaseMetaData.tableIndexHashed ? "hash" : "btree");
                columns.computeIfAbsent(name, k -> new TreeMap<>()).put(rs.getInt("ORDINAL_POSITION"), column);
            }
        } catch (SQLFeatureNotSupportedException unsupported) { return MAPPER.createArrayNode(); }
        ArrayNode result = MAPPER.createArrayNode();
        indexes.forEach((name, item) -> { item.put("columns", String.join(", ", columns.get(name).values())); result.add(item); });
        return result;
    }

    private static JsonNode getForeignKeys(JsonNode connection, String database, String schema, String table) throws SQLException {
        Connection conn = openConnection(connection);
        DatabaseMetaData meta = conn.getMetaData();
        JdbcDriverQuirks quirks = driverQuirks(connection);
        String catalog = metadataCatalog(database, quirks);
        String namespace = resolveSchemaPattern(meta, database, schema, quirks);
        ArrayNode result = foreignKeys(meta, catalog, namespace, table);
        return result.isEmpty() && catalog != null ? foreignKeys(meta, null, namespace, table) : result;
    }

    private static ArrayNode foreignKeys(DatabaseMetaData meta, String catalog, String schema, String table) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        try (ResultSet rs = meta.getImportedKeys(catalog, schema, table)) {
            while (rs.next()) {
                ObjectNode item = result.addObject();
                String refSchema = rs.getString("PKTABLE_SCHEM");
                if (refSchema == null || refSchema.isBlank()) refSchema = rs.getString("PKTABLE_CAT");
                String fromSchema = rs.getString("FKTABLE_SCHEM");
                if (fromSchema == null || fromSchema.isBlank()) fromSchema = rs.getString("FKTABLE_CAT");
                item.put("ref_schema", refSchema);
                item.put("from_schema", fromSchema);
                item.put("key_seq", rs.getInt("KEY_SEQ"));
                item.put("column", rs.getString("FKCOLUMN_NAME"));
                item.put("references", (refSchema == null || refSchema.isBlank() ? "" : refSchema + ".")
                    + rs.getString("PKTABLE_NAME") + "." + rs.getString("PKCOLUMN_NAME"));
                item.put("ref_table", rs.getString("PKTABLE_NAME"));
                item.put("ref_column", rs.getString("PKCOLUMN_NAME"));
                item.put("constraint_name", rs.getString("FK_NAME"));
                item.put("on_delete", foreignKeyRule(rs.getShort("DELETE_RULE")));
                item.put("on_update", foreignKeyRule(rs.getShort("UPDATE_RULE")));
            }
        } catch (SQLFeatureNotSupportedException unsupported) { return MAPPER.createArrayNode(); }
        return result;
    }

    private static String foreignKeyRule(short rule) {
        return switch (rule) {
            case DatabaseMetaData.importedKeyCascade -> "CASCADE";
            case DatabaseMetaData.importedKeyRestrict -> "RESTRICT";
            case DatabaseMetaData.importedKeySetNull -> "SET NULL";
            case DatabaseMetaData.importedKeySetDefault -> "SET DEFAULT";
            default -> "NO ACTION";
        };
    }

    private static void applyStatementOptions(Statement statement, int maxRows, int fetchSize, int timeoutSecs)
        throws SQLException {
        statement.setMaxRows((int) Math.min(Integer.MAX_VALUE, (long) maxRows + 1L));
        if (fetchSize > 0) {
            try {
                statement.setFetchSize(fetchSize);
            } catch (SQLFeatureNotSupportedException ignored) {
            }
        }
        if (timeoutSecs >= 0) {
            try {
                statement.setQueryTimeout(timeoutSecs);
            } catch (SQLFeatureNotSupportedException ignored) {
            }
        }
    }

    private static String trimStatementSql(String sql) {
        return sql == null ? "" : sql.trim().replaceFirst(";\\s*$", "");
    }

    private static void applyExecutionContext(JsonNode connection, Connection conn, String database, String schema) throws SQLException {
        if (driverQuirks(connection).skipExecutionContext()) {
            return;
        }
        String catalog = emptyToNull(database);
        if (catalog != null) {
            try {
                conn.setCatalog(catalog);
            } catch (SQLFeatureNotSupportedException | AbstractMethodError ignored) {
            }
            if (driverQuirks(connection).useCatalogFallbackSql()) {
                applyUseCatalogFallback(conn, catalog);
            }
        }
        if (schema != null) {
            try {
                conn.setSchema(schema);
            } catch (SQLFeatureNotSupportedException | AbstractMethodError ignored) {
            }
        }
    }

    private static void applyUseCatalogFallback(Connection conn, String catalog) {
        try (Statement statement = conn.createStatement()) {
            statement.execute("USE " + quoteJdbcIdentifier(catalog));
        } catch (SQLException | AbstractMethodError ignored) {
        }
    }

    private static String quoteJdbcIdentifier(String identifier) {
        if (identifier != null && identifier.matches("[A-Za-z_][A-Za-z0-9_]*")) {
            return identifier;
        }
        return "`" + identifier.replace("`", "``") + "`";
    }

    static JdbcDriverQuirks driverQuirks(JsonNode connection) {
        String url = optionalText(connection, "connection_string");
        for (JdbcDriverQuirkRule rule : DRIVER_QUIRK_RULES) {
            if (urlMatchesPrefix(url, rule.urlPrefix())) {
                return rule.quirks();
            }
        }
        if (isKyuubiDriver(connection)) {
            return USE_CATALOG_QUIRKS;
        }
        return DEFAULT_QUIRKS;
    }

    private static boolean isKyuubiDriver(JsonNode connection) {
        String driverClass = optionalText(connection, "jdbc_driver_class");
        if (driverClass != null && driverClass.toLowerCase(Locale.ROOT).contains("kyuubi")) {
            return true;
        }
        JsonNode paths = connection.path("jdbc_driver_paths");
        if (!paths.isArray()) {
            return false;
        }
        for (JsonNode path : paths) {
            if (path.asText("").toLowerCase(Locale.ROOT).contains("kyuubi")) {
                return true;
            }
        }
        return false;
    }

    private static boolean urlMatchesPrefix(String url, String prefix) {
        return url != null && url.regionMatches(true, 0, prefix, 0, prefix.length());
    }

    private static JsonNode listDatabases(JsonNode connection) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        Connection conn = openConnection(connection);
        if (driverQuirks(connection).useOracleMetadata()) {
            return result;
        }
        try (ResultSet rs = conn.getMetaData().getCatalogs()) {
            while (rs.next()) {
                String name = rs.getString("TABLE_CAT");
                addDatabase(result, name);
            }
        }
        addDatabase(result, optionalText(connection, "database"));
        try {
            addDatabase(result, conn.getCatalog());
        } catch (SQLFeatureNotSupportedException | AbstractMethodError ignored) {
        }
        return result;
    }

    private static void addDatabase(ArrayNode result, String name) {
        if (name == null || name.isBlank()) {
            return;
        }
        for (JsonNode item : result) {
            if (name.equals(item.path("name").asText())) {
                return;
            }
        }
        ObjectNode item = MAPPER.createObjectNode();
        item.put("name", name);
        result.add(item);
    }

    private static JsonNode listSchemas(JsonNode connection, String database) throws SQLException {
        return listSchemas(openConnection(connection), database, driverQuirks(connection));
    }

    static JsonNode listSchemas(Connection conn, String database, JdbcDriverQuirks quirks) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        String catalog = metadataCatalog(database, quirks);
        if (quirks.useOracleMetadata()) {
            return oracleListSchemas(conn);
        }
        DatabaseMetaData meta = conn.getMetaData();
        if (quirks.caseInsensitiveSchemaMetadata()) {
            try (ResultSet rs = meta.getSchemas(catalog, null)) {
                appendSchemas(result, rs, true);
            } catch (SQLException | UnsupportedOperationException | AbstractMethodError ignored) {
                try (ResultSet rs = meta.getSchemas()) {
                    appendSchemas(result, rs, true);
                } catch (SQLFeatureNotSupportedException | UnsupportedOperationException | AbstractMethodError ignoredLegacy) {
                    // Both overloads may be absent on legacy drivers; try the actual default schema below.
                }
            }
            try (ResultSet rs = meta.getSchemas(null, null)) {
                appendSchemas(result, rs, true);
            } catch (SQLException | UnsupportedOperationException | AbstractMethodError ignored) {
            }
        } else {
            try (ResultSet rs = meta.getSchemas(catalog, null)) {
                appendSchemas(result, rs, false);
            } catch (SQLFeatureNotSupportedException | UnsupportedOperationException | AbstractMethodError ignored) {
                try (ResultSet rs = meta.getSchemas()) {
                    appendSchemas(result, rs, false);
                } catch (SQLFeatureNotSupportedException | UnsupportedOperationException | AbstractMethodError ignoredLegacy) {
                    // Unsupported capability is not a permission/query error; other SQLExceptions still propagate.
                }
            }
            if (result.isEmpty() && catalog != null) {
                try (ResultSet rs = meta.getSchemas(null, null)) {
                    appendSchemas(result, rs, false);
                } catch (SQLFeatureNotSupportedException | UnsupportedOperationException | AbstractMethodError ignored) {
                }
            }
        }
        if (result.isEmpty()) {
            try {
                String schema = conn.getSchema();
                if (schema != null) {
                    addSchema(result, schema, quirks.caseInsensitiveSchemaMetadata());
                }
            } catch (SQLFeatureNotSupportedException | AbstractMethodError ignored) {
            }
        }
        return result;
    }

    private static JsonNode listTables(JsonNode connection, String database, String schema) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        Connection conn = openConnection(connection);
        JdbcDriverQuirks quirks = driverQuirks(connection);
        if (quirks.useOracleMetadata()) {
            return oracleListTables(conn, oracleEffectiveSchema(conn, schema));
        }
        String[] types = new String[] {"TABLE", "VIEW", "MATERIALIZED VIEW", "SYSTEM TABLE", "SYSTEM VIEW"};
        DatabaseMetaData meta = conn.getMetaData();
        String catalog = metadataCatalog(database, quirks);
        String schemaPattern = resolveSchemaPattern(meta, database, schema, quirks);
        appendTables(result, meta, catalog, schemaPattern, types);
        if (result.isEmpty() && catalog != null) {
            appendTables(result, meta, null, schemaPattern, types);
        }
        return result;
    }

    private static JsonNode listObjects(JsonNode connection, String database, String schema) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        Connection conn = openConnection(connection);
        if (driverQuirks(connection).useOracleMetadata()) {
            return oracleListObjects(conn, oracleEffectiveSchema(conn, schema), schema);
        }
        DatabaseMetaData meta = conn.getMetaData();
        JdbcDriverQuirks quirks = driverQuirks(connection);
        String catalog = metadataCatalog(database, quirks);
        String schemaPattern = resolveSchemaPattern(meta, database, schema, quirks);

        String[] tableTypes = new String[] {"TABLE", "VIEW", "MATERIALIZED VIEW", "SYSTEM TABLE", "SYSTEM VIEW"};
        appendTableObjects(result, meta, catalog, schemaPattern, schema, tableTypes);
        if (result.isEmpty() && catalog != null) {
            appendTableObjects(result, meta, null, schemaPattern, schema, tableTypes);
        }

        try (ResultSet rs = meta.getProcedures(catalog, schemaPattern, "%")) {
            while (rs.next()) {
                ObjectNode item = MAPPER.createObjectNode();
                item.put("name", rs.getString("PROCEDURE_NAME"));
                item.put("object_type", "PROCEDURE");
                putNullable(item, "schema", schema);
                putNullable(item, "comment", rs.getString("REMARKS"));
                result.add(item);
            }
        } catch (SQLException ignored) {
        }

        Set<String> procedureNames = new HashSet<>();
        for (JsonNode node : result) {
            if ("PROCEDURE".equals(node.path("object_type").asText())) {
                procedureNames.add(node.path("name").asText());
            }
        }
        try (ResultSet rs = meta.getFunctions(catalog, schemaPattern, "%")) {
            while (rs.next()) {
                String name = rs.getString("FUNCTION_NAME");
                if (!procedureNames.contains(name)) {
                    ObjectNode item = MAPPER.createObjectNode();
                    item.put("name", name);
                    item.put("object_type", "FUNCTION");
                    putNullable(item, "schema", schema);
                    putNullable(item, "comment", rs.getString("REMARKS"));
                    result.add(item);
                }
            }
        } catch (SQLException ignored) {
        }

        return result;
    }

    private static JsonNode getColumns(JsonNode connection, String database, String schema, String table) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        Connection conn = openConnection(connection);
        if (driverQuirks(connection).useOracleMetadata()) {
            return oracleGetColumns(conn, oracleEffectiveSchema(conn, schema), table);
        }
        DatabaseMetaData meta = conn.getMetaData();
        JdbcDriverQuirks quirks = driverQuirks(connection);
        String catalog = metadataCatalog(database, quirks);
        String schemaPattern = resolveSchemaPattern(meta, database, schema, quirks);
        Set<String> primaryKeys = safePrimaryKeys(meta, catalog, schemaPattern, table);
        appendColumns(result, meta, catalog, schemaPattern, table, primaryKeys);
        if (result.isEmpty() && catalog != null) {
            primaryKeys = safePrimaryKeys(meta, null, schemaPattern, table);
            appendColumns(result, meta, null, schemaPattern, table, primaryKeys);
        }
        if (quirks.useCatalogFallbackSql()) {
            mergeShowFullColumnComments(conn, result, schemaPattern, table);
        }
        return result;
    }

    private static void appendSchemas(ArrayNode result, ResultSet rs, boolean caseInsensitive) throws SQLException {
        while (rs.next()) {
            String schema = rs.getString("TABLE_SCHEM");
            addSchema(result, schema, caseInsensitive);
        }
    }

    private static void addSchema(ArrayNode result, String schema, boolean caseInsensitive) {
        if (schema == null || schema.isBlank()) {
            return;
        }
        String key = schemaKey(schema, caseInsensitive);
        for (int i = 0; i < result.size(); i++) {
            String existing = result.get(i).asText("");
            if (schemaKey(existing, caseInsensitive).equals(key)) {
                if (preferSchemaDisplayName(existing, schema)) {
                    result.set(i, MAPPER.getNodeFactory().textNode(schema));
                }
                return;
            }
        }
        result.add(schema);
    }

    static boolean preferSchemaDisplayName(String existing, String candidate) {
        return isAllUppercaseIdentifier(existing) && !isAllUppercaseIdentifier(candidate);
    }

    private static boolean isAllUppercaseIdentifier(String value) {
        return value != null && value.equals(value.toUpperCase(Locale.ROOT)) && !value.equals(value.toLowerCase(Locale.ROOT));
    }

    private static String schemaKey(String schema, boolean caseInsensitive) {
        return caseInsensitive ? schema.toLowerCase(Locale.ROOT) : schema;
    }

    private static String metadataCatalog(String database, JdbcDriverQuirks quirks) {
        if (quirks.caseInsensitiveSchemaMetadata() || quirks.ignoreCatalogForSchemaMetadata()) {
            return null;
        }
        return emptyToNull(database);
    }

    private static String resolveSchemaPattern(
        DatabaseMetaData meta,
        String database,
        String schema,
        JdbcDriverQuirks quirks
    ) throws SQLException {
        String schemaPattern = emptyToNull(schema);
        if (schemaPattern == null || !quirks.caseInsensitiveSchemaMetadata()) {
            return schemaPattern;
        }
        String resolved = null;
        try {
            resolved = findSchemaPattern(meta, metadataCatalog(database, quirks), schemaPattern);
        } catch (SQLException ignored) {
        }
        if (resolved != null) {
            return resolved;
        }
        resolved = findSchemaPattern(meta, null, schemaPattern);
        return resolved == null ? schemaPattern : resolved;
    }

    private static String findSchemaPattern(DatabaseMetaData meta, String catalog, String schema) throws SQLException {
        try (ResultSet rs = meta.getSchemas(catalog, null)) {
            String fallback = null;
            while (rs.next()) {
                String candidate = rs.getString("TABLE_SCHEM");
                if (candidate == null || candidate.isBlank()) {
                    continue;
                }
                if (candidate.equals(schema)) {
                    return candidate;
                }
                if (candidate.equalsIgnoreCase(schema) && (fallback == null || preferSchemaDisplayName(fallback, candidate))) {
                    fallback = candidate;
                }
            }
            return fallback;
        } catch (SQLFeatureNotSupportedException | UnsupportedOperationException | AbstractMethodError ignored) {
            return null;
        }
    }

    private static void appendTables(
        ArrayNode result,
        DatabaseMetaData meta,
        String catalog,
        String schema,
        String[] types
    ) throws SQLException {
        try (ResultSet rs = meta.getTables(catalog, schema, "%", types)) {
            while (rs.next()) {
                ObjectNode item = MAPPER.createObjectNode();
                item.put("name", rs.getString("TABLE_NAME"));
                item.put("table_type", rs.getString("TABLE_TYPE"));
                putNullable(item, "comment", rs.getString("REMARKS"));
                result.add(item);
            }
        }
    }

    private static void appendTableObjects(
        ArrayNode result,
        DatabaseMetaData meta,
        String catalog,
        String schemaPattern,
        String schema,
        String[] tableTypes
    ) throws SQLException {
        try (ResultSet rs = meta.getTables(catalog, schemaPattern, "%", tableTypes)) {
            while (rs.next()) {
                ObjectNode item = MAPPER.createObjectNode();
                item.put("name", rs.getString("TABLE_NAME"));
                item.put("object_type", rs.getString("TABLE_TYPE"));
                putNullable(item, "schema", schema);
                putNullable(item, "comment", rs.getString("REMARKS"));
                result.add(item);
            }
        }
    }

    private static void appendColumns(
        ArrayNode result,
        DatabaseMetaData meta,
        String catalog,
        String schema,
        String table,
        Set<String> primaryKeys
    ) throws SQLException {
        try (ResultSet rs = meta.getColumns(catalog, schema, table, "%")) {
            while (rs.next()) {
                String name = rs.getString("COLUMN_NAME");
                ObjectNode item = columnNode(result, name);
                item.put("data_type", rs.getString("TYPE_NAME"));
                item.put("is_nullable", rs.getInt("NULLABLE") != DatabaseMetaData.columnNoNulls);
                putNullablePreferValue(item, "column_default", rs.getString("COLUMN_DEF"));
                item.put("is_primary_key", primaryKeys.contains(name));
                item.putNull("extra");
                putNullablePreferValue(item, "comment", rs.getString("REMARKS"));
                putNullableInt(item, "numeric_precision", rs.getObject("COLUMN_SIZE"));
                putNullableInt(item, "numeric_scale", rs.getObject("DECIMAL_DIGITS"));
                putNullableInt(item, "character_maximum_length", rs.getObject("COLUMN_SIZE"));
            }
        }
    }

    private static void mergeShowFullColumnComments(Connection conn, ArrayNode result, String schema, String table) {
        String target = qualifiedJdbcTableName(schema, table);
        try (Statement statement = conn.createStatement(); ResultSet rs = statement.executeQuery("SHOW FULL COLUMNS FROM " + target)) {
            int fieldIndex = resultSetColumnIndex(rs, "Field");
            int commentIndex = resultSetColumnIndex(rs, "Comment");
            if (fieldIndex <= 0 || commentIndex <= 0) {
                return;
            }
            while (rs.next()) {
                String name = rs.getString(fieldIndex);
                String comment = rs.getString(commentIndex);
                if (name != null) {
                    putNullablePreferValue(columnNode(result, name), "comment", comment);
                }
            }
        } catch (SQLException | AbstractMethodError ignored) {
        }
    }

    private static String qualifiedJdbcTableName(String schema, String table) {
        String tableName = quoteJdbcIdentifier(table);
        String schemaName = emptyToNull(schema);
        return schemaName == null ? tableName : quoteJdbcIdentifier(schemaName) + "." + tableName;
    }

    private static int resultSetColumnIndex(ResultSet rs, String label) throws SQLException {
        ResultSetMetaData meta = rs.getMetaData();
        for (int i = 1; i <= meta.getColumnCount(); i++) {
            if (label.equalsIgnoreCase(meta.getColumnLabel(i)) || label.equalsIgnoreCase(meta.getColumnName(i))) {
                return i;
            }
        }
        return -1;
    }

    private static void closeSharedConnection() {SessionRuntime.closeAll();}

    private static String driverKey(JsonNode connection) {
        return optionalText(connection, "jdbc_driver_class") + "|" + connection.path("jdbc_driver_paths").toString();
    }

    private static String connectionKey(JsonNode connection) {
        return optionalText(connection, "connection_string")
            + "|" + optionalText(connection, "url_params")
            + "|" + optionalText(connection, "username")
            + "|" + optionalText(connection, "password")
            + "|" + connection.path("sysdba").asBoolean(false);
    }

    private static Set<String> primaryKeys(DatabaseMetaData meta, String database, String schema, String table) throws SQLException {
        Set<String> primaryKeys = new HashSet<>();
        try (ResultSet rs = meta.getPrimaryKeys(emptyToNull(database), emptyToNull(schema), table)) {
            while (rs.next()) {
                primaryKeys.add(rs.getString("COLUMN_NAME"));
            }
        }
        return primaryKeys;
    }

    private static Set<String> safePrimaryKeys(DatabaseMetaData meta, String database, String schema, String table) {
        try {
            return primaryKeys(meta, database, schema, table);
        } catch (SQLException ignored) {
            return Collections.emptySet();
        }
    }

    // --- Oracle-specific metadata methods ---

    private static boolean isOracleUrl(String url) {
        return url != null && url.regionMatches(true, 0, "jdbc:oracle:", 0, 12);
    }

    static String jdbcUrlWithPasswordKey(String url, String password) {
        if (url == null || password == null || password.isBlank() || !isSqliteUrl(url)) {
            return url;
        }
        if (!urlHasQueryParam(url, "cipher") || urlHasQueryParam(url, "key")) {
            return url;
        }
        return appendJdbcUrlParam(url, "key", password);
    }

    static String jdbcUrl(JsonNode connection) {
        String url = appendJdbcUrlParams(optionalText(connection, "connection_string"), optionalText(connection, "url_params"));
        return jdbcUrlWithPasswordKey(url, optionalText(connection, "password"));
    }

    private static boolean isSqliteUrl(String url) {
        return url.regionMatches(true, 0, "jdbc:sqlite:", 0, 12);
    }

    private static boolean urlHasQueryParam(String url, String key) {
        int queryStart = url.indexOf('?');
        if (queryStart < 0) {
            return false;
        }
        int fragmentStart = url.indexOf('#', queryStart + 1);
        String query = fragmentStart < 0 ? url.substring(queryStart + 1) : url.substring(queryStart + 1, fragmentStart);
        for (String part : query.split("[&;]")) {
            int equals = part.indexOf('=');
            String name = equals < 0 ? part : part.substring(0, equals);
            if (name.equalsIgnoreCase(key)) {
                return true;
            }
        }
        return false;
    }

    private static String appendJdbcUrlParam(String url, String key, String value) {
        int fragmentStart = url.indexOf('#');
        String base = fragmentStart < 0 ? url : url.substring(0, fragmentStart);
        String fragment = fragmentStart < 0 ? "" : url.substring(fragmentStart);
        String separator = base.contains("?") ? (base.endsWith("?") || base.endsWith("&") ? "" : "&") : "?";
        String encodedValue = URLEncoder.encode(value, StandardCharsets.UTF_8);
        return base + separator + key + "=" + encodedValue + fragment;
    }

    static String appendJdbcUrlParams(String url, String urlParams) {
        if (url == null || urlParams == null || urlParams.isBlank()) {
            return url;
        }
        String params = urlParams.trim();
        while (params.startsWith("?") || params.startsWith("&") || params.startsWith(";") || params.startsWith(":")) {
            params = params.substring(1).trim();
        }
        if (params.isEmpty()) {
            return url;
        }

        int fragmentStart = url.indexOf('#');
        String base = fragmentStart < 0 ? url : url.substring(0, fragmentStart);
        String fragment = fragmentStart < 0 ? "" : url.substring(fragmentStart);
        if (jdbcUrlUsesColonProperties(base) && !params.endsWith(";")) {
            params = params + ";";
        }
        String separator = jdbcUrlParamSeparator(base);
        return base + separator + params + fragment;
    }

    private static String jdbcUrlParamSeparator(String base) {
        if (urlMatchesPrefix(base, "jdbc:sqlserver:")) {
            return base.endsWith(";") ? "" : ";";
        }
        if (jdbcUrlUsesColonProperties(base)) {
            if (base.endsWith(":") || base.endsWith(";")) {
                return "";
            }
            return jdbcUrlHasColonProperties(base) ? ";" : ":";
        }
        return base.contains("?") ? (base.endsWith("?") || base.endsWith("&") ? "" : "&") : "?";
    }

    private static boolean jdbcUrlUsesColonProperties(String base) {
        return urlMatchesPrefix(base, "jdbc:db2:") || urlMatchesPrefix(base, "jdbc:informix-sqli:");
    }

    private static boolean jdbcUrlHasColonProperties(String base) {
        int schemeEnd = base.indexOf("://");
        if (schemeEnd < 0) {
            return false;
        }
        int pathStart = base.indexOf('/', schemeEnd + 3);
        if (pathStart < 0) {
            return false;
        }
        return base.indexOf(':', pathStart + 1) >= 0;
    }

    private static String oracleEffectiveSchema(Connection conn, String schema) throws SQLException {
        if (schema != null && !schema.isBlank()) {
            return oracleResolveOwner(conn, schema);
        }
        String username = conn.getMetaData().getUserName();
        return username == null || username.isBlank() ? username : oracleResolveOwner(conn, username);
    }

    private static String oracleResolveOwner(Connection conn, String owner) throws SQLException {
        String exact = oracleFindIdentifier(
            conn,
            "SELECT username FROM all_users WHERE username = ?",
            owner
        );
        if (exact != null) {
            return exact;
        }
        String upper = owner.toUpperCase();
        exact = oracleFindIdentifier(
            conn,
            "SELECT username FROM all_users WHERE username = ?",
            upper
        );
        return exact == null ? owner : exact;
    }

    private static String oracleResolveTable(Connection conn, String owner, String table) throws SQLException {
        String exact = oracleFindIdentifier(
            conn,
            "SELECT table_name FROM all_tab_comments WHERE owner = ? AND table_name = ?",
            owner,
            table
        );
        if (exact != null) {
            return exact;
        }
        String upper = table.toUpperCase();
        exact = oracleFindIdentifier(
            conn,
            "SELECT table_name FROM all_tab_comments WHERE owner = ? AND table_name = ?",
            owner,
            upper
        );
        return exact == null ? table : exact;
    }

    private static String oracleFindIdentifier(Connection conn, String sql, String first) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, first);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    return rs.getString(1);
                }
            }
        }
        return null;
    }

    private static String oracleFindIdentifier(Connection conn, String sql, String first, String second) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, first);
            ps.setString(2, second);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    return rs.getString(1);
                }
            }
        }
        return null;
    }

    private static JsonNode oracleListSchemas(Connection conn) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery("SELECT username FROM all_users ORDER BY username")) {
            while (rs.next()) {
                String name = rs.getString(1);
                if (name != null && !name.isBlank()) {
                    result.add(name);
                }
            }
        }
        return result;
    }

    private static JsonNode oracleListTables(Connection conn, String owner) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        String sql =
            "SELECT table_name AS name, 'TABLE' AS table_type, comments " +
            "FROM all_tab_comments WHERE owner = ? AND table_type = 'TABLE' " +
            "UNION ALL " +
            "SELECT table_name AS name, 'VIEW' AS table_type, comments " +
            "FROM all_tab_comments WHERE owner = ? AND table_type = 'VIEW' " +
            "ORDER BY name";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, owner);
            ps.setString(2, owner);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ObjectNode item = MAPPER.createObjectNode();
                    item.put("name", rs.getString("name"));
                    item.put("table_type", rs.getString("table_type"));
                    putNullable(item, "comment", rs.getString("comments"));
                    result.add(item);
                }
            }
        }
        return result;
    }

    private static JsonNode oracleListObjects(Connection conn, String owner, String schemaLabel) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        String tableSql =
            "SELECT table_name AS name, table_type AS object_type, comments " +
            "FROM all_tab_comments WHERE owner = ? ORDER BY name";
        try (PreparedStatement ps = conn.prepareStatement(tableSql)) {
            ps.setString(1, owner);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ObjectNode item = MAPPER.createObjectNode();
                    item.put("name", rs.getString("name"));
                    item.put("object_type", rs.getString("object_type"));
                    putNullable(item, "schema", schemaLabel);
                    putNullable(item, "comment", rs.getString("comments"));
                    result.add(item);
                }
            }
        }
        String procSql =
            "SELECT object_name AS name, object_type " +
            "FROM all_procedures WHERE owner = ? AND object_type IN ('PROCEDURE', 'FUNCTION') " +
            "AND procedure_name IS NULL ORDER BY object_name";
        try (PreparedStatement ps = conn.prepareStatement(procSql)) {
            ps.setString(1, owner);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ObjectNode item = MAPPER.createObjectNode();
                    item.put("name", rs.getString("name"));
                    item.put("object_type", rs.getString("object_type"));
                    putNullable(item, "schema", schemaLabel);
                    item.putNull("comment");
                    result.add(item);
                }
            }
        }
        String packageSql =
            "SELECT object_name AS name, CASE object_type WHEN 'PACKAGE BODY' THEN 'PACKAGE_BODY' ELSE object_type END AS object_type " +
            "FROM all_objects WHERE owner = ? AND object_type IN ('PACKAGE', 'PACKAGE BODY') ORDER BY object_type, object_name";
        try (PreparedStatement ps = conn.prepareStatement(packageSql)) {
            ps.setString(1, owner);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ObjectNode item = MAPPER.createObjectNode();
                    item.put("name", rs.getString("name"));
                    item.put("object_type", rs.getString("object_type"));
                    putNullable(item, "schema", schemaLabel);
                    item.putNull("comment");
                    result.add(item);
                }
            }
        }
        return result;
    }

    private static JsonNode getObjectSource(JsonNode connection, String database, String schema, String name, String objectType)
        throws SQLException {
        Connection conn = openConnection(connection);
        if (!driverQuirks(connection).useOracleMetadata()) {
            throw new SQLException("Object source is not supported by this JDBC driver");
        }
        String owner = oracleEffectiveSchema(conn, schema);
        String metadataType = oracleMetadataObjectType(objectType);
        String sql = "SELECT DBMS_METADATA.GET_DDL(?, ?, ?) FROM DUAL";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, metadataType);
            ps.setString(2, name);
            ps.setString(3, owner);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    throw new SQLException("Object source not found");
                }
                ObjectNode item = MAPPER.createObjectNode();
                item.put("name", name);
                item.put("object_type", objectType);
                putNullable(item, "schema", owner);
                putNullable(item, "source", rs.getString(1));
                return item;
            }
        }
    }

    private static String oracleMetadataObjectType(String objectType) {
        String normalized = objectType == null ? "" : objectType.trim().toUpperCase().replace(' ', '_');
        return switch (normalized) {
            case "VIEW" -> "VIEW";
            case "PROCEDURE" -> "PROCEDURE";
            case "FUNCTION" -> "FUNCTION";
            case "PACKAGE" -> "PACKAGE";
            case "PACKAGE_BODY" -> "PACKAGE_BODY";
            default -> normalized;
        };
    }

    private static JsonNode oracleGetColumns(Connection conn, String owner, String table) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        String resolvedTable = oracleResolveTable(conn, owner, table);
        Set<String> pks = oraclePrimaryKeys(conn, owner, resolvedTable);
        // data_default is a LONG column — it must be read first in JDBC, before any other
        // column, otherwise the data is truncated. We put it at position 1 for this reason.
        String sql =
            "SELECT c.data_default, c.column_name, c.data_type, c.nullable, " +
            "c.data_precision, c.data_scale, c.char_length, cc.comments " +
            "FROM all_tab_columns c " +
            "LEFT JOIN all_col_comments cc ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name " +
            "WHERE c.owner = ? AND c.table_name = ? ORDER BY c.column_id";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, owner);
            ps.setString(2, resolvedTable);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    // data_default is a LONG — read it first, before all other columns.
                    String dataDefault = rs.getString("data_default");
                    String name = rs.getString("column_name");
                    ObjectNode item = columnNode(result, name);
                    item.put("data_type", rs.getString("data_type"));
                    item.put("is_nullable", !"N".equals(rs.getString("nullable")));
                    putNullablePreferValue(item, "column_default", dataDefault);
                    item.put("is_primary_key", pks.contains(name));
                    item.putNull("extra");
                    putNullablePreferValue(item, "comment", rs.getString("comments"));
                    putNullableInt(item, "numeric_precision", rs.getObject("data_precision"));
                    putNullableInt(item, "numeric_scale", rs.getObject("data_scale"));
                    putNullableInt(item, "character_maximum_length", rs.getObject("char_length"));
                }
            }
        }
        return result;
    }

    private static Set<String> oraclePrimaryKeys(Connection conn, String owner, String table) throws SQLException {
        Set<String> keys = new HashSet<>();
        String sql =
            "SELECT cols.column_name FROM all_constraints cons " +
            "JOIN all_cons_columns cols ON cons.constraint_name = cols.constraint_name AND cons.owner = cols.owner " +
            "WHERE cons.constraint_type = 'P' AND cons.owner = ? AND cons.table_name = ?";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, owner);
            ps.setString(2, table);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    keys.add(rs.getString("column_name"));
                }
            }
        }
        return keys;
    }

    private static Object readValue(ResultSet rs, ResultSetMetaData meta, int index) throws SQLException {
        Object value = rs.getObject(index);
        if (value == null) {
            return null;
        }
        if (value instanceof byte[] bytes && "JSON".equalsIgnoreCase(meta.getColumnTypeName(index))) return new String(bytes, StandardCharsets.UTF_8);
        if (value instanceof byte[] bytes) {
            return binaryToHex(bytes);
        }
        if (isBinaryColumn(meta, index)) {
            byte[] bytes = rs.getBytes(index);
            return bytes == null ? null : binaryToHex(bytes);
        }
        if (value instanceof Date || value instanceof Time || value instanceof Timestamp || value instanceof TemporalAccessor) {
            return value.toString();
        }
        if (value instanceof BigDecimal decimal) {
            return decimal.toPlainString();
        }
        if (value instanceof Long number && (number > 9007199254740991L || number < -9007199254740991L)) return number.toString();
        if (value instanceof BigInteger number) return number.toString();
        if (value instanceof Double number && !Double.isFinite(number)) return number.toString();
        if (value instanceof Float number && !Float.isFinite(number)) return number.toString();
        if (value instanceof Number || value instanceof Boolean || value instanceof String) {
            return value;
        }
        return value.toString();
    }

    private static boolean isBinaryColumn(ResultSetMetaData meta, int index) throws SQLException {
        return switch (meta.getColumnType(index)) {
            case Types.BINARY,
                 Types.VARBINARY,
                 Types.LONGVARBINARY,
                 Types.BLOB -> true;
            default -> false;
        };
    }

    private static String binaryToHex(byte[] bytes) {
        StringBuilder out = new StringBuilder(2 + bytes.length * 2);
        out.append("0x");
        for (byte b : bytes) {
            out.append(Character.forDigit((b >> 4) & 0x0f, 16));
            out.append(Character.forDigit(b & 0x0f, 16));
        }
        return out.toString();
    }

    private static void putNullable(ObjectNode node, String field, String value) {
        if (value == null) {
            node.putNull(field);
        } else {
            node.put(field, value);
        }
    }

    private static ObjectNode columnNode(ArrayNode result, String name) {
        for (JsonNode node : result) {
            if (name.equals(node.path("name").asText()) && node instanceof ObjectNode objectNode) {
                return objectNode;
            }
        }
        ObjectNode item = MAPPER.createObjectNode();
        item.put("name", name);
        result.add(item);
        return item;
    }

    private static void putNullablePreferValue(ObjectNode node, String field, String value) {
        if (value == null || value.isBlank()) {
            if (!node.has(field)) {
                node.putNull(field);
            }
            return;
        }
        node.put(field, value);
    }

    private static void putNullableInt(ObjectNode node, String field, Object value) {
        if (value instanceof Number number) {
            node.put(field, number.intValue());
        } else {
            node.putNull(field);
        }
    }

    private static String requireText(JsonNode node, String field) {
        String value = optionalText(node, field);
        if (value == null) {
            throw new IllegalArgumentException(field + " is required.");
        }
        return value;
    }

    private static String optionalText(JsonNode node, String field) {
        JsonNode value = node.path(field);
        if (value.isMissingNode() || value.isNull()) {
            return null;
        }
        String text = value.asText("").trim();
        return text.isEmpty() ? null : text;
    }

    private static int positiveInt(JsonNode node, String field, int defaultValue) {
        return Math.max(1, nonNegativeInt(node, field, defaultValue));
    }

    private static int nonNegativeInt(JsonNode node, String field, int defaultValue) {
        JsonNode value = node.path(field);
        if (value.isMissingNode() || value.isNull()) {
            return defaultValue;
        }
        if (!value.canConvertToInt()) {
            return defaultValue;
        }
        return Math.max(0, value.asInt(defaultValue));
    }

    private static String emptyToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    private static Path expandHome(String path) {
        if (path.equals("~") || path.startsWith("~/")) {
            return Path.of(System.getProperty("user.home") + path.substring(1));
        }
        return Path.of(path);
    }

    private static final class DriverShim implements Driver {
        private final Driver driver;

        private DriverShim(Driver driver) {
            this.driver = driver;
        }

        @Override
        public Connection connect(String url, Properties info) throws SQLException {
            return driver.connect(url, info);
        }

        @Override
        public boolean acceptsURL(String url) throws SQLException {
            return driver.acceptsURL(url);
        }

        @Override
        public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) throws SQLException {
            return driver.getPropertyInfo(url, info);
        }

        @Override
        public int getMajorVersion() {
            return driver.getMajorVersion();
        }

        @Override
        public int getMinorVersion() {
            return driver.getMinorVersion();
        }

        @Override
        public boolean jdbcCompliant() {
            return driver.jdbcCompliant();
        }

        @Override
        public Logger getParentLogger() throws SQLFeatureNotSupportedException {
            return driver.getParentLogger();
        }
    }
}
