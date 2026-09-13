import android.content.SharedPreferences;
import androidx.preference.*;
import eu.kanade.tachiyomi.source.ConfigurableSource;
import eu.kanade.tachiyomi.source.online.HttpSource;
import org.moya.apk.HostContext;
import org.moya.apk.Preferences;
import org.json.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

class PreferencesSmoke {
    static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
    static String key(String source, String field) { return new JSONArray(List.of(source, field)).toString(); }
    static class Source extends HttpSource implements ConfigurableSource {
        final HostContext context;
        final long id;
        Source(HostContext context, long id) { this.context = context; this.id = id; }
        public String getBaseUrl() { return "https://example.org"; }
        public String getName() { return "Fixture " + id; }
        public String getLang() { return "en"; }
        public long getId() { return id; }
        public boolean getSupportsLatest() { return true; }
        public SharedPreferences getSourcePreferences() { return context.getSharedPreferences("source_" + id, 0); }
        public void setupPreferenceScreen(PreferenceScreen screen) {
            var enabled = new SwitchPreferenceCompat(context);
            enabled.setKey("enabled"); enabled.setTitle("Use external server"); enabled.setDefaultValue(false);
            screen.addPreference(enabled);
            var endpoint = new EditTextPreference(context);
            endpoint.setKey("endpoint"); endpoint.setTitle("Server address"); endpoint.setDefaultValue("");
            endpoint.setOnPreferenceChangeListener((p, value) -> {
                // Real extensions sometimes write before returning false. The whole save must roll back.
                getSourcePreferences().edit().putString("callback", "written").apply();
                context.getSharedPreferences("newly_loaded", 0).edit().putStringSet("items", Set.of("new")).apply();
                return !value.equals("reject");
            });
            screen.addPreference(endpoint);
            var token = new EditTextPreference(context);
            token.setKey("access_key"); token.setTitle("Access key"); token.setDefaultValue("");
            token.setSummary("Never expose a credential in a dynamic summary"); screen.addPreference(token);
            var mode = new ListPreference(context);
            mode.setKey("mode"); mode.setTitle("Mode"); mode.setDefaultValue("a");
            mode.setEntries(new String[]{"First", "Second"}); mode.setEntryValues(new String[]{"a", "b"}); screen.addPreference(mode);
            var action = new Preference(context); action.setTitle("Open Android window");
            action.setOnPreferenceClickListener(p -> { throw new AssertionError("must not execute UI action"); });
            screen.addPreference(action);
        }
    }
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("moya-preferences-smoke-");
        try {
            String legacyName = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest("source_1".getBytes(StandardCharsets.UTF_8)));
            Path legacy = root.resolve(legacyName + ".json");
            Files.writeString(legacy, "{\"endpoint\":\"https://old.example\",\"access_key\":\"fixture-secret\"}");
            var context = new HostContext(root, "org.example.fixture");
            Map<String, HttpSource> sources = Map.of("1", new Source(context, 1), "2", new Source(context, 2));
            var snapshot = Preferences.INSTANCE.read(sources, context);
            require(snapshot.getJSONArray("fields").length() == 9, "host proxy and original fields/source grouping");
            require(!snapshot.toString().contains("fixture-secret"), "redacted credential");
            require(!snapshot.toString().contains("dynamic summary"), "redacted summary");
            var changes = new JSONObject().put(key("1", "enabled"), true).put(key("1", "endpoint"), "http://127.0.0.1:8080")
                .put(key("1", "mode"), "b").put("__moya_outbound_proxy", "socks5://127.0.0.1:40000");
            context.transaction(() -> Preferences.INSTANCE.save(sources, context, changes));
            require(!Files.exists(legacy), "migrated plaintext removed after commit");
            require(!new String(Files.readAllBytes(root.resolve("preferences.enc")), StandardCharsets.ISO_8859_1).contains("fixture-secret"), "encrypted at rest");
            var restored = new HostContext(root, "org.example.fixture");
            require(restored.getOutboundProxy().equals("socks5://127.0.0.1:40000"), "proxy survives encrypted restart");
            var prefs = restored.getSharedPreferences("source_1", 0);
            require(prefs.getBoolean("enabled", false), "enabled survives restart");
            require(prefs.getString("endpoint", "").equals("http://127.0.0.1:8080"), "endpoint survives restart");
            require(prefs.getString("access_key", "").equals("fixture-secret"), "unchanged secret retained");
            require(restored.getSharedPreferences("source_2", 0).getAll().isEmpty(), "sources isolated");
            Map<String, HttpSource> reopened = Map.of("1", new Source(restored, 1));
            byte[] before = Files.readAllBytes(root.resolve("preferences.enc"));
            try {
                restored.transaction(() -> Preferences.INSTANCE.save(reopened, restored, new JSONObject().put(key("1", "endpoint"), "reject")));
                throw new AssertionError("rejection expected");
            } catch (IllegalArgumentException expected) { }
            require(Arrays.equals(before, Files.readAllBytes(root.resolve("preferences.enc"))), "rejection leaves disk unchanged");
            require(prefs.getString("endpoint", "").equals("http://127.0.0.1:8080"), "rejection restores memory");
            require(restored.getSharedPreferences("newly_loaded", 0).getStringSet("items", Set.of()).equals(Set.of("new")), "rollback restores sets in newly loaded namespace");
            try {
                restored.transaction(() -> Preferences.INSTANCE.save(reopened, restored, new JSONObject().put(key("1", "mode"), "invalid")));
                throw new AssertionError("invalid choice expected");
            } catch (IllegalArgumentException expected) { }
            try {
                restored.transaction(() -> Preferences.INSTANCE.save(reopened, restored, new JSONObject().put(key("1", "unknown"), "value")));
                throw new AssertionError("unknown key expected");
            } catch (NoSuchElementException expected) { }
            restored.transaction(() -> Preferences.INSTANCE.save(reopened, restored, new JSONObject().put(key("1", "access_key"), "")));
            require(new HostContext(root, "org.example.fixture").getSharedPreferences("source_1", 0).getString("access_key", "missing").isEmpty(), "explicit secret removal");
            byte[] corrupt = Files.readAllBytes(root.resolve("preferences.enc")); corrupt[corrupt.length - 1] ^= 1;
            Files.write(root.resolve("preferences.enc"), corrupt);
            try { new HostContext(root, "org.example.fixture"); throw new AssertionError("corrupt data must not reset silently"); }
            catch (javax.crypto.AEADBadTagException expected) { }
            System.out.println("APK preferences: original fields, isolation, encrypted restart, migration, validation and rollback passed");
        } finally {
            try (var paths = Files.walk(root)) { for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path); }
        }
    }
}
