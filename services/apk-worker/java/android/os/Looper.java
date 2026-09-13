package android.os;

import java.util.concurrent.ScheduledThreadPoolExecutor;

/** Minimal headless main dispatcher. Does not provide an Android UI or WebView. */
public final class Looper {
    private static final ThreadLocal<Looper> CURRENT = new ThreadLocal<>();
    private static final Looper MAIN = new Looper();
    final ScheduledThreadPoolExecutor executor;
    private volatile Thread thread;
    private Looper() {
        executor = new ScheduledThreadPoolExecutor(1, runnable -> {
            Thread value = new Thread(() -> { CURRENT.set(this); runnable.run(); }, "moya-apk-main");
            value.setDaemon(true); thread = value; return value;
        });
        executor.setRemoveOnCancelPolicy(true);
        executor.prestartCoreThread();
    }
    public static Looper getMainLooper() { return MAIN; }
    public static Looper myLooper() { return CURRENT.get(); }
    public Thread getThread() { return thread; }
    public boolean isCurrentThread() { return Thread.currentThread() == thread; }
    public static void prepare() { throw new UnsupportedOperationException("android_thread_looper"); }
    public static void prepareMainLooper() { throw new UnsupportedOperationException("android_main_already_prepared"); }
    public static void loop() { throw new UnsupportedOperationException("android_thread_looper"); }
    public void quit() { executor.shutdownNow(); }
    public void quitSafely() { executor.shutdown(); }
}
