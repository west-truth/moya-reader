import android.app.Application;
import android.content.SharedPreferences;
import java.lang.reflect.Proxy;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import uy.kohesive.injekt.api.InjektRegistrar;
import uy.kohesive.injekt.api.InjektScope;

/** Manual compatibility probe, not a production worker or an arbitrary-code sandbox. */
public final class Probe {
    static final class Context extends Application {
        private final Map<String, SharedPreferences> preferences = new HashMap<>();
        public android.content.Context getApplicationContext() { return this; }
        public String getPackageName() { return "org.example.compatprobe"; }
        public SharedPreferences getSharedPreferences(String name, int mode) {
            return preferences.computeIfAbsent(name, ignored -> memoryPreferences());
        }
        private SharedPreferences memoryPreferences() {
            Map<String, Object> values = new HashMap<>();
            Object[] editor = new Object[1];
            editor[0] = Proxy.newProxyInstance(getClass().getClassLoader(), new Class[]{SharedPreferences.Editor.class}, (p, m, a) -> {
                if (m.getName().startsWith("put")) { values.put((String) a[0], a[1]); return editor[0]; }
                if (m.getName().equals("remove")) { values.remove(a[0]); return editor[0]; }
                if (m.getName().equals("clear")) { values.clear(); return editor[0]; }
                if (m.getName().equals("commit")) return true;
                if (m.getName().equals("apply")) return null;
                throw new UnsupportedOperationException(m.getName());
            });
            return (SharedPreferences) Proxy.newProxyInstance(getClass().getClassLoader(), new Class[]{SharedPreferences.class}, (p, m, a) -> {
                if (m.getName().equals("edit")) return editor[0];
                if (m.getName().equals("getAll")) return new HashMap<>(values);
                if (m.getName().equals("contains")) return values.containsKey(a[0]);
                if (m.getName().startsWith("get")) return values.getOrDefault(a[0], a[1]);
                if (m.getName().endsWith("OnSharedPreferenceChangeListener")) return null;
                throw new UnsupportedOperationException(m.getName());
            });
        }
    }

    public static void main(String[] args) throws Exception {
        long start = System.nanoTime();
        var context = new Context();
        var network = new eu.kanade.tachiyomi.network.NetworkHelper();
        var json = kotlinx.serialization.json.JsonKt.Json(kotlinx.serialization.json.Json.Default, builder -> {
            builder.setIgnoreUnknownKeys(true);
            builder.setLenient(true);
            return kotlin.Unit.INSTANCE;
        });
        var registrar = (InjektRegistrar) Proxy.newProxyInstance(Probe.class.getClassLoader(), new Class[]{InjektRegistrar.class}, (p, m, a) -> {
            if (m.getName().equals("hasFactory")) return true;
            String type = a[0].toString();
            if (type.equals("class eu.kanade.tachiyomi.network.NetworkHelper")) return network;
            if (type.equals("class kotlinx.serialization.json.Json")) return json;
            if (type.equals("class android.app.Application") || type.equals("class android.content.Context")) return context;
            throw new IllegalStateException("unbound_dependency:" + type);
        });
        uy.kohesive.injekt.InjektKt.setInjekt(new InjektScope(registrar));
        Object instance = Class.forName(args[0]).getConstructor().newInstance();
        java.util.List<eu.kanade.tachiyomi.source.Source> sources;
        if (instance instanceof eu.kanade.tachiyomi.source.SourceFactory factory) sources = factory.createSources();
        else if (instance instanceof eu.kanade.tachiyomi.source.Source single) sources = java.util.List.of(single);
        else throw new IllegalStateException("unsupported_source_api");
        if (sources.isEmpty() || sources.size() > 1000 || sources.stream().map(s -> s.getId()).distinct().count() != sources.size())
            throw new IllegalStateException("invalid_source_factory");
        System.out.println("sourceCount=" + sources.size());
        String selectedId = args.length > 2 ? args[2] : "";
        var source = (eu.kanade.tachiyomi.source.online.HttpSource) sources.stream()
            .filter(s -> s instanceof eu.kanade.tachiyomi.source.online.HttpSource)
            .filter(s -> selectedId.isEmpty() || Long.toString(s.getId()).equals(selectedId))
            .findFirst().orElseThrow(() -> new IllegalStateException("unknown_source"));
        if (source.getName().isBlank() || source.getId() == 0) throw new IllegalStateException("invalid_source_identity");
        System.out.println("loaded=true");
        System.out.println("loadMs=" + (System.nanoTime() - start) / 1_000_000);
        if (args.length > 1 && args[1].equals("live")) {
            var works = source.fetchSearchManga(1, "", new eu.kanade.tachiyomi.source.model.FilterList())
                .timeout(15, TimeUnit.SECONDS).toBlocking().single();
            System.out.println("works=" + works.getMangas().size());
            if (works.getMangas().isEmpty()) throw new IllegalStateException("empty_works");
            var chapters = source.fetchChapterList(works.getMangas().get(0)).timeout(15, TimeUnit.SECONDS).toBlocking().single();
            System.out.println("chapters=" + chapters.size());
            if (chapters.isEmpty()) throw new IllegalStateException("empty_chapters");
            // Prefer the oldest release; never unlock paid/access-controlled content.
            var pages = source.fetchPageList(chapters.get(chapters.size() - 1)).timeout(15, TimeUnit.SECONDS).toBlocking().single();
            System.out.println("pages=" + pages.size());
            if (pages.isEmpty()) throw new IllegalStateException("empty_pages");
            String imageUrl = pages.get(0).getImageUrl();
            if (imageUrl == null) imageUrl = source.fetchImageUrl(pages.get(0)).timeout(15, TimeUnit.SECONDS).toBlocking().single();
            try (var image = source.getClient().newCall(new okhttp3.Request.Builder().url(imageUrl).headers(source.getHeaders()).build()).execute()) {
                if (!image.isSuccessful() || image.body() == null || !image.header("Content-Type", "").startsWith("image/"))
                    throw new IllegalStateException("invalid_image_response");
                // Bound diagnostic reads; nothing is saved to the library or returned as a book asset.
                byte[] bytes = image.body().byteStream().readNBytes(20 * 1024 * 1024 + 1);
                boolean jpeg = bytes.length > 3 && (bytes[0] & 255) == 255 && (bytes[1] & 255) == 216;
                boolean png = bytes.length > 8 && bytes[0] == (byte) 137 && bytes[1] == 80 && bytes[2] == 78 && bytes[3] == 71;
                boolean gif = bytes.length > 6 && bytes[0] == 71 && bytes[1] == 73 && bytes[2] == 70;
                boolean webp = bytes.length > 12 && bytes[0] == 82 && bytes[1] == 73 && bytes[8] == 87 && bytes[9] == 69;
                if (bytes.length > 20 * 1024 * 1024 || !(jpeg || png || gif || webp)) throw new IllegalStateException("invalid_image_bytes");
                System.out.println("imageBytes=" + bytes.length);
                System.out.println("imageVerified=true");
            }
        }
        System.out.println("heapUsedBytes=" + java.lang.management.ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getUsed());
        System.out.println("totalMs=" + (System.nanoTime() - start) / 1_000_000);
    }
}
