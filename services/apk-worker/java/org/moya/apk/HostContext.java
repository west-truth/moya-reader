package org.moya.apk;

import android.content.SharedPreferences;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import org.json.JSONObject;

/** APK-private preference files. The host supplies a dedicated installation directory. */
public final class HostContext extends android.app.Application {
    private final Path directory;
    private final String packageName;
    private final Map<String, SharedPreferences> preferences = new HashMap<>();
    private final Map<String, Map<String, Object>> loadedValues = new HashMap<>();
    private final PreferenceStorage storage;
    public HostContext(Path directory, String packageName) throws Exception {
        this.directory = directory.toRealPath(); this.packageName = packageName;
        storage = new PreferenceStorage(this.directory);
    }
    public String getPackageName() { return packageName; }
    public String getOutboundProxy() { return getSharedPreferences("moya.host.network", 0).getString("proxy", ""); }
    public void setOutboundProxy(String value) { getSharedPreferences("moya.host.network", 0).edit().putString("proxy", value).commit(); }
    public synchronized SharedPreferences getSharedPreferences(String name, int mode) {
        if (name == null || name.length() > 1024) throw new IllegalArgumentException("invalid_preference_name");
        return preferences.computeIfAbsent(name, key -> {
            try { return create(key); } catch (Exception error) { throw new IllegalStateException("preferences_unavailable", error); }
        });
    }
    private SharedPreferences create(String name) throws Exception {
        String key = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(name.getBytes(StandardCharsets.UTF_8)));
        Map<String, Object> values = storage.read(key);
        values.replaceAll((k, v) -> v instanceof List<?> list ? new HashSet<>(list) : v);
        loadedValues.put(key, values);
        Set<SharedPreferences.OnSharedPreferenceChangeListener> listeners = new HashSet<>();
        SharedPreferences[] self = new SharedPreferences[1];
        self[0] = (SharedPreferences) Proxy.newProxyInstance(getClassLoader(), new Class[]{SharedPreferences.class}, (proxy, method, args) -> {
            synchronized (HostContext.this) {
                String operation = method.getName();
                if (operation.equals("edit")) {
                    Map<String, Object> changes = new HashMap<>(); boolean[] clear = {false}; Object[] editor = new Object[1];
                    editor[0] = Proxy.newProxyInstance(getClassLoader(), new Class[]{SharedPreferences.Editor.class}, (p, m, a) -> {
                        synchronized (HostContext.this) {
                            String op = m.getName();
                            if (op.startsWith("put")) { changes.put((String) a[0], a[1] instanceof Set<?> set ? new HashSet<>(set) : a[1]); return editor[0]; }
                            if (op.equals("remove")) { changes.put((String) a[0], null); return editor[0]; }
                            if (op.equals("clear")) { clear[0] = true; return editor[0]; }
                            if (op.equals("commit") || op.equals("apply")) {
                                Map<String, Object> next = clear[0] ? new HashMap<>() : new HashMap<>(values);
                                changes.forEach((k, v) -> { if (v == null) next.remove(k); else next.put(k, v); });
                                String data = new JSONObject(next).toString();
                                if (data.getBytes(StandardCharsets.UTF_8).length > 1024 * 1024 || next.size() > 1000)
                                    throw new IllegalStateException("preferences_limit");
                                storage.save(key, next);
                                Set<String> changed = new HashSet<>(changes.keySet()); if (clear[0]) changed.addAll(values.keySet());
                                values.clear(); values.putAll(next); changes.clear(); clear[0] = false;
                                for (var listener : List.copyOf(listeners)) for (String k : changed) listener.onSharedPreferenceChanged(self[0], k);
                                return op.equals("commit") ? true : null;
                            }
                            throw new UnsupportedOperationException("preference_editor_method");
                        }
                    });
                    return editor[0];
                }
                if (operation.equals("getAll")) {
                    Map<String, Object> copy = new HashMap<>(values);
                    copy.replaceAll((k, v) -> v instanceof Set<?> set ? new HashSet<>(set) : v); return copy;
                }
                if (operation.equals("contains")) return values.containsKey(args[0]);
                if (operation.startsWith("get")) {
                    Object value = values.getOrDefault(args[0], args[1]);
                    if (value instanceof Number number) return switch (operation) {
                        case "getInt" -> number.intValue(); case "getLong" -> number.longValue(); case "getFloat" -> number.floatValue(); default -> value;
                    };
                    return value instanceof Set<?> set ? new HashSet<>(set) : value;
                }
                if (operation.equals("registerOnSharedPreferenceChangeListener")) { listeners.add((SharedPreferences.OnSharedPreferenceChangeListener) args[0]); return null; }
                if (operation.equals("unregisterOnSharedPreferenceChangeListener")) { listeners.remove(args[0]); return null; }
                throw new UnsupportedOperationException("preference_method");
            }
        });
        return self[0];
    }
    public synchronized <T> T transaction(java.util.concurrent.Callable<T> action) throws Exception {
        Map<String, Map<String, Object>> previous = new HashMap<>();
        loadedValues.forEach((name, values) -> previous.put(name, new HashMap<>(values)));
        storage.begin();
        try { T value = action.call(); storage.commit(); return value; }
        catch (Exception | LinkageError error) {
            storage.rollback();
            for (var entry : loadedValues.entrySet()) {
                Map<String, Object> saved = previous.get(entry.getKey());
                if (saved == null) saved = storage.read(entry.getKey());
                saved.replaceAll((k, v) -> v instanceof List<?> list ? new HashSet<>(list) : v);
                entry.getValue().clear(); entry.getValue().putAll(saved);
            }
            throw error;
        }
    }
}
