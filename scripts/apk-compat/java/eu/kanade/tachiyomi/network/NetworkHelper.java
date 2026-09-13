package eu.kanade.tachiyomi.network;

/** Diagnostic ABI replacement; deliberately has no server config, DB, cache or challenge solver. */
public final class NetworkHelper {
    private final okhttp3.OkHttpClient client = new okhttp3.OkHttpClient.Builder()
        .callTimeout(java.time.Duration.ofSeconds(12)).build();

    public okhttp3.OkHttpClient getClient() { return client; }
    public okhttp3.OkHttpClient getCloudflareClient() { return client; }
    public String defaultUserAgentProvider() { return "Mozilla/5.0"; }
}
