import eu.kanade.tachiyomi.network.NetworkHelper;
import okhttp3.Cookie;
import okhttp3.HttpUrl;
import java.util.List;

class NetworkSessionSmoke {
    static void require(boolean value) { if (!value) throw new AssertionError("cookie boundary"); }
    public static void main(String[] args) {
        var first = new NetworkHelper().getClient().cookieJar();
        var second = new NetworkHelper().getClient().cookieJar();
        var origin = HttpUrl.get("https://example.org/catalog/list");
        first.saveFromResponse(origin, List.of(Cookie.parse(origin, "session=one; Path=/catalog; Secure")));
        require(first.loadForRequest(origin).size() == 1);
        require(second.loadForRequest(origin).isEmpty());
        require(first.loadForRequest(HttpUrl.get("https://other.example/catalog/list")).isEmpty());
        require(first.loadForRequest(HttpUrl.get("https://example.org/elsewhere")).isEmpty());
        require(first.loadForRequest(HttpUrl.get("http://example.org/catalog/list")).isEmpty());
        first.saveFromResponse(origin, List.of(Cookie.parse(origin, "session=two; Path=/catalog; Secure")));
        require(first.loadForRequest(origin).get(0).value().equals("two"));
        first.saveFromResponse(origin, List.of(Cookie.parse(origin, "session=gone; Path=/catalog; Max-Age=0")));
        require(first.loadForRequest(origin).isEmpty());
        var configured = new java.util.concurrent.atomic.AtomicReference<>("http://127.0.0.1:40000");
        var selector = new NetworkHelper(configured::get).getClient().proxySelector();
        var publicTarget = java.net.URI.create("https://198.51.100.1/page.jpg");
        require(selector.select(publicTarget).get(0).type() == java.net.Proxy.Type.HTTP);
        configured.set("socks5://127.0.0.1:40000");
        require(selector.select(publicTarget).get(0).type() == java.net.Proxy.Type.SOCKS);
        require(selector.select(java.net.URI.create("http://127.0.0.1:9870/jobs")).get(0).type() == java.net.Proxy.Type.DIRECT);
        require(selector.select(java.net.URI.create("http://192.168.1.10/jobs")).get(0).type() == java.net.Proxy.Type.DIRECT);
        for (String invalid : List.of("file:///tmp/x", "http://user:pass@localhost:80", "http://localhost:0", "socks5://localhost/path")) {
            try { NetworkHelper.validateProxy(invalid); throw new AssertionError("invalid proxy accepted"); }
            catch (IllegalArgumentException expected) { }
        }
        System.out.println("APK session cookies: scope, replacement, expiry and isolation passed");
    }
}
