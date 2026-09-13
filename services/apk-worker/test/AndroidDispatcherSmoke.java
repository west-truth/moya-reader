import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.ArrayList;
import java.util.List;

/** Run with Java 21 source launcher and the built worker jar; no network or APK fixture. */
class AndroidDispatcherSmoke {
    static void require(boolean value) { if (!value) throw new AssertionError("dispatcher contract"); }
    public static void main(String[] args) throws Exception {
        Looper looper = Looper.getMainLooper(); Handler handler = new Handler(looper);
        CountDownLatch done = new CountDownLatch(3); List<Integer> order = new ArrayList<>();
        AtomicBoolean identity = new AtomicBoolean(); AtomicBoolean cancelled = new AtomicBoolean();
        handler.post(() -> { identity.set(Looper.myLooper() == looper && looper.isCurrentThread()); order.add(1); done.countDown(); });
        handler.post(() -> { order.add(2); done.countDown(); });
        long started = SystemClock.uptimeMillis();
        handler.postDelayed(() -> { require(SystemClock.uptimeMillis() - started >= 20); order.add(3); done.countDown(); }, 30);
        Object token = new Object(); Runnable removed = () -> cancelled.set(true);
        handler.postDelayed(removed, token, 100); require(handler.hasCallbacks(removed));
        handler.removeCallbacksAndMessages(token); require(!handler.hasCallbacks(removed));
        require(done.await(3, TimeUnit.SECONDS)); require(identity.get()); require(order.equals(List.of(1,2,3)));
        CountDownLatch message = new CountDownLatch(1);
        Handler receiver = new Handler(looper, value -> { require(value.what == 4 && value.arg1 == 5 && value.obj == token); message.countDown(); return true; });
        receiver.obtainMessage(4,5,6,token).sendToTarget(); require(message.await(3,TimeUnit.SECONDS));
        for (int n = 0; n < 1024; n++) handler.postDelayed(removed, 10000);
        try { handler.postDelayed(removed, 10000); throw new AssertionError("missing admission bound"); }
        catch (IllegalStateException expected) { require(expected.getMessage().equals("android_message_limit")); }
        handler.removeCallbacksAndMessages(null);
        SystemClock.sleep(120); require(!cancelled.get());
        System.out.println("Android dispatcher: FIFO, delay, thread identity, messages, cancellation and bound passed");
    }
}
