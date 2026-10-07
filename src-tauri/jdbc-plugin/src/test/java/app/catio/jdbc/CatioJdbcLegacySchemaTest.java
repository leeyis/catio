package app.catio.jdbc;

import org.junit.jupiter.api.Test;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.*;
import static org.junit.jupiter.api.Assertions.*;

class CatioJdbcLegacySchemaTest {
    private static Connection legacy(Connection actual, Throwable failure, boolean bothOverloads) throws Exception {
        DatabaseMetaData real = actual.getMetaData();
        DatabaseMetaData meta = (DatabaseMetaData) Proxy.newProxyInstance(CatioJdbcLegacySchemaTest.class.getClassLoader(), new Class<?>[]{DatabaseMetaData.class}, (proxy, method, args) -> {
            if (method.getName().equals("getSchemas") && (method.getParameterCount() == 2 || bothOverloads)) throw failure;
            try { return method.invoke(real, args); } catch (InvocationTargetException e) { throw e.getCause(); }
        });
        return (Connection) Proxy.newProxyInstance(CatioJdbcLegacySchemaTest.class.getClassLoader(), new Class<?>[]{Connection.class}, (proxy, method, args) -> {
            if (method.getName().equals("getMetaData")) return meta;
            try { return method.invoke(actual, args); } catch (InvocationTargetException e) { throw e.getCause(); }
        });
    }
    private static CatioJdbcPlugin.JdbcDriverQuirks quirks(boolean insensitive) {
        return new CatioJdbcPlugin.JdbcDriverQuirks(false, false, insensitive, false, false);
    }
    @Test void abstractTwoArgumentMethodFallsBackToLegacyOverloadForBothQuirkBranches() throws Exception {
        for (boolean insensitive : new boolean[]{false, true}) try (Connection actual = DriverManager.getConnection("jdbc:h2:mem:legacy_schema")) {
            var schemas = CatioJdbcPlugin.listSchemas(legacy(actual, new AbstractMethodError("legacy driver"), false), actual.getCatalog(), quirks(insensitive));
            assertTrue(schemas.toString().contains("PUBLIC"));
            assertTrue(schemas.toString().contains("INFORMATION_SCHEMA"), "must enumerate, not just return the default schema");
        }
    }
    @Test void unsupportedOverloadsCanStillReturnActualExecutionSchema() throws Exception {
        for (boolean insensitive : new boolean[]{false, true}) try (Connection actual = DriverManager.getConnection("jdbc:h2:mem:legacy_default")) {
            var schemas = CatioJdbcPlugin.listSchemas(legacy(actual, new AbstractMethodError("no schema enumeration"), true), actual.getCatalog(), quirks(insensitive));
            assertEquals(1, schemas.size());
            assertEquals("PUBLIC", schemas.get(0).asText());
        }
    }
    @Test void unsupportedOperationUsesTheSameCapabilityFallback() throws Exception {
        try (Connection actual = DriverManager.getConnection("jdbc:h2:mem:legacy_unsupported")) {
            var schemas = CatioJdbcPlugin.listSchemas(legacy(actual, new UnsupportedOperationException("not implemented"), false), actual.getCatalog(), quirks(false));
            assertTrue(schemas.toString().contains("INFORMATION_SCHEMA"));
        }
    }
    @Test void schemaPatternResolutionKeepsTheRequestedNameWhenEnumerationIsUnsupported() throws Exception {
        try (Connection actual = DriverManager.getConnection("jdbc:h2:mem:legacy_pattern")) {
            var resolve = CatioJdbcPlugin.class.getDeclaredMethod("resolveSchemaPattern", DatabaseMetaData.class, String.class, String.class, CatioJdbcPlugin.JdbcDriverQuirks.class);
            resolve.setAccessible(true);
            assertEquals("PUBLIC", resolve.invoke(null, legacy(actual, new AbstractMethodError("legacy schema pattern"), true).getMetaData(), actual.getCatalog(), "PUBLIC", quirks(true)));
        }
    }
    @Test void unrelatedFailuresAreNotSilentlyTurnedIntoEmptyMetadata() throws Exception {
        try (Connection actual = DriverManager.getConnection("jdbc:h2:mem:legacy_denied")) {
            assertThrows(SQLException.class, () -> CatioJdbcPlugin.listSchemas(legacy(actual, new SQLException("permission denied", "42501"), false), actual.getCatalog(), quirks(false)));
            assertThrows(IllegalStateException.class, () -> CatioJdbcPlugin.listSchemas(legacy(actual, new IllegalStateException("driver broken"), false), actual.getCatalog(), quirks(false)));
        }
    }
}
