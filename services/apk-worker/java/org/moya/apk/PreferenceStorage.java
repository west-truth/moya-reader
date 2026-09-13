package org.moya.apk;

import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.*;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONObject;

/** Atomic encrypted settings per installation; no user-entered application password. */
final class PreferenceStorage {
    private final Path directory, file;
    private final byte[] key;
    private JSONObject values;
    private String before;
    PreferenceStorage(Path directory) throws Exception {
        this.directory = directory; file = directory.resolve("preferences.enc");
        Path keyFile = directory.resolve("preferences.key");
        if (!Files.exists(keyFile)) {
            byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes);
            try { privateWrite(keyFile, bytes); }
            catch (FileAlreadyExistsException ignored) { }
        }
        key = Files.readAllBytes(keyFile);
        if (key.length != 32) throw new IllegalStateException("preferences_unavailable");
        if (Files.exists(file)) {
            if (Files.size(file) > 16 * 1024 * 1024) throw new IllegalStateException("preferences_limit");
            byte[] bytes = Files.readAllBytes(file);
            if (bytes.length < 29 || bytes[0] != 1) throw new IllegalStateException("preferences_unavailable");
            values = new JSONObject(new String(cipher(Cipher.DECRYPT_MODE, Arrays.copyOfRange(bytes, 1, 13))
                .doFinal(Arrays.copyOfRange(bytes, 13, bytes.length)), StandardCharsets.UTF_8));
        } else values = new JSONObject();
    }
    private Cipher cipher(int mode, byte[] iv) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(mode, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv)); return cipher;
    }
    private static void privateWrite(Path path, byte[] bytes) throws Exception {
        try (var channel = Files.newByteChannel(path, Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE),
            java.nio.file.attribute.PosixFilePermissions.asFileAttribute(java.nio.file.attribute.PosixFilePermissions.fromString("rw-------")))) {
            java.nio.ByteBuffer buffer = java.nio.ByteBuffer.wrap(bytes);
            while (buffer.hasRemaining()) channel.write(buffer);
        } catch (UnsupportedOperationException error) { Files.write(path, bytes, StandardOpenOption.CREATE_NEW); }
    }
    Map<String, Object> read(String name) throws Exception {
        if (!values.has(name)) {
            Path legacy = directory.resolve(name + ".json");
            if (Files.exists(legacy)) {
                if (Files.size(legacy) > 1024 * 1024) throw new IllegalStateException("preferences_limit");
                values.put(name, new JSONObject(Files.readString(legacy)));
            }
        }
        JSONObject value = values.optJSONObject(name);
        return value == null ? new HashMap<>() : value.toMap();
    }
    void save(String name, Map<String, Object> value) throws Exception {
        JSONObject previous = values.optJSONObject(name);
        values.put(name, new JSONObject(value));
        try { if (before == null) persist(); }
        catch (Exception error) { if (previous == null) values.remove(name); else values.put(name, previous); throw error; }
    }
    void begin() { if (before != null) throw new IllegalStateException("preferences_busy"); before = values.toString(); }
    void commit() throws Exception { persist(); before = null; }
    void rollback() { values = new JSONObject(before); before = null; }
    private void persist() throws Exception {
        byte[] body = values.toString().getBytes(StandardCharsets.UTF_8);
        if (body.length > 16 * 1024 * 1024 - 29) throw new IllegalStateException("preferences_limit");
        byte[] iv = new byte[12]; new SecureRandom().nextBytes(iv);
        byte[] encrypted = cipher(Cipher.ENCRYPT_MODE, iv).doFinal(body);
        byte[] bytes = new byte[13 + encrypted.length]; bytes[0] = 1;
        System.arraycopy(iv, 0, bytes, 1, 12); System.arraycopy(encrypted, 0, bytes, 13, encrypted.length);
        Path staged = directory.resolve("preferences-" + UUID.randomUUID() + ".tmp");
        try {
            privateWrite(staged, bytes);
            try { Files.move(staged, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
            catch (AtomicMoveNotSupportedException error) { Files.move(staged, file, StandardCopyOption.REPLACE_EXISTING); }
        } finally { Files.deleteIfExists(staged); }
        // Remove only hashed legacy files whose data is now durably included in the encrypted document.
        for (String name : values.keySet()) if (name.matches("[a-f0-9]{64}")) {
            try { Files.deleteIfExists(directory.resolve(name + ".json")); } catch (java.io.IOException ignored) { }
        }
    }
}
