package android.os;

/** Monotonic clock for callbacks and coroutine dispatch. */
public final class SystemClock {
    private SystemClock() {}
    public static long uptimeMillis() { return System.nanoTime() / 1_000_000; }
    public static long elapsedRealtime() { return uptimeMillis(); }
    public static long elapsedRealtimeNanos() { return System.nanoTime(); }
    public static void sleep(long millis) {
        long remaining = Math.max(0, millis); long started = uptimeMillis(); boolean interrupted = false;
        while (remaining > 0) {
            try { Thread.sleep(remaining); } catch (InterruptedException error) { interrupted = true; }
            remaining = millis - (uptimeMillis() - started);
        }
        if (interrupted) Thread.currentThread().interrupt();
    }
}
