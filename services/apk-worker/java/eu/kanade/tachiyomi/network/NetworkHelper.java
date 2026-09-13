package eu.kanade.tachiyomi.network;

/** Headless source ABI; deliberately has no server config, DB or challenge solver. */
public final class NetworkHelper {
    private final okhttp3.OkHttpClient client;
    public NetworkHelper() { this(() -> ""); }
    public NetworkHelper(java.util.function.Supplier<String> configuredProxy) {
        var defaults = java.net.ProxySelector.getDefault();
        client = new okhttp3.OkHttpClient.Builder().cookieJar(new SessionCookies())
            .proxySelector(new java.net.ProxySelector() {
                public java.util.List<java.net.Proxy> select(java.net.URI target) {
                    String value = validateProxy(configuredProxy.get());
                    if (value.isEmpty()) return defaults == null ? java.util.List.of(java.net.Proxy.NO_PROXY) : defaults.select(target);
                    if (localHost(target.getHost())) return java.util.List.of(java.net.Proxy.NO_PROXY);
                    var proxy = java.net.URI.create(value);
                    int port = proxy.getPort() == -1 ? (proxy.getScheme().equals("socks5") ? 1080 : 80) : proxy.getPort();
                    return java.util.List.of(new java.net.Proxy(proxy.getScheme().equals("socks5") ? java.net.Proxy.Type.SOCKS : java.net.Proxy.Type.HTTP,
                        new java.net.InetSocketAddress(proxy.getHost(), port)));
                }
                public void connectFailed(java.net.URI uri, java.net.SocketAddress address, java.io.IOException error) { }
            }).callTimeout(java.time.Duration.ofSeconds(12)).build();
    }
    public static String validateProxy(String value) {
        if (value == null || value.trim().isEmpty()) return "";
        if (value.length() > 2048) throw new IllegalArgumentException("invalid_proxy");
        var uri = java.net.URI.create(value.trim());
        if (!("http".equals(uri.getScheme()) || "socks5".equals(uri.getScheme())) || uri.getHost() == null ||
            uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null ||
            !(uri.getPath().isEmpty() || uri.getPath().equals("/")) || uri.getPort() == 0 || uri.getPort() > 65535)
            throw new IllegalArgumentException("invalid_proxy");
        return uri.toString();
    }
    private static boolean localHost(String host) {
        if (host == null) return false;
        try {
            var addresses = java.net.InetAddress.getAllByName(host);
            return java.util.Arrays.stream(addresses).anyMatch(address -> address.isLoopbackAddress() || address.isSiteLocalAddress() || address.isLinkLocalAddress());
        } catch (java.net.UnknownHostException error) { return false; }
    }

    public okhttp3.OkHttpClient getClient() { return client; }
    public okhttp3.OkHttpClient getCloudflareClient() { return client; }
    public String defaultUserAgentProvider() { return "Mozilla/5.0"; }

    /** Session state is installation/process scoped; it is never shared with the app browser. */
    static final class SessionCookies implements okhttp3.CookieJar {
        private final java.util.LinkedHashMap<String, okhttp3.Cookie> values = new java.util.LinkedHashMap<>();
        public synchronized void saveFromResponse(okhttp3.HttpUrl url, java.util.List<okhttp3.Cookie> cookies) {
            values.values().removeIf(cookie -> cookie.expiresAt() <= System.currentTimeMillis());
            for (okhttp3.Cookie cookie : cookies) {
                String key = cookie.domain() + "\n" + cookie.path() + "\n" + cookie.name();
                values.remove(key);
                if (cookie.expiresAt() > System.currentTimeMillis()) {
                    while (values.size() >= 4096) values.remove(values.keySet().iterator().next());
                    values.put(key, cookie);
                }
            }
        }
        public synchronized java.util.List<okhttp3.Cookie> loadForRequest(okhttp3.HttpUrl url) {
            values.values().removeIf(cookie -> cookie.expiresAt() <= System.currentTimeMillis());
            return values.values().stream().filter(cookie -> cookie.matches(url)).toList();
        }
    }
}
