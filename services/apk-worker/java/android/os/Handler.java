package android.os;

import java.util.IdentityHashMap;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;

/** Bounded FIFO dispatcher with Android callback/token cancellation semantics. */
public class Handler {
    public interface Callback { boolean handleMessage(Message message); }
    private final Looper looper;
    private final Callback callback;
    private final IdentityHashMap<Message, ScheduledFuture<?>> pending = new IdentityHashMap<>();
    public Handler() { this(Looper.myLooper(), null); }
    public Handler(Callback callback) { this(Looper.myLooper(), callback); }
    public Handler(Looper looper) { this(looper, null); }
    public Handler(Looper looper, Callback callback) {
        if (looper == null) throw new IllegalStateException("android_looper_required");
        this.looper = looper; this.callback = callback;
    }
    public Handler(Looper looper, Callback callback, boolean async) { this(looper, callback); }
    public static Handler createAsync(Looper looper) { return new Handler(looper); }
    public static Handler createAsync(Looper looper, Callback callback) { return new Handler(looper, callback); }
    public final Looper getLooper() { return looper; }
    public void handleMessage(Message message) {}
    public void dispatchMessage(Message message) {
        if (message.callback != null) message.callback.run();
        else if (callback == null || !callback.handleMessage(message)) handleMessage(message);
    }
    public final Message obtainMessage() { return Message.obtain(this); }
    public final Message obtainMessage(int what) { return Message.obtain(this, what); }
    public final Message obtainMessage(int what, Object obj) { return Message.obtain(this, what, obj); }
    public final Message obtainMessage(int what, int arg1, int arg2) { return Message.obtain(this, what, arg1, arg2); }
    public final Message obtainMessage(int what, int arg1, int arg2, Object obj) { return Message.obtain(this, what, arg1, arg2, obj); }
    public final boolean post(Runnable runnable) { return postDelayed(runnable, 0); }
    public final boolean postDelayed(Runnable runnable, long delay) { return sendMessageDelayed(Message.obtain(this, runnable), delay); }
    public final boolean postDelayed(Runnable runnable, Object token, long delay) {
        Message message = Message.obtain(this, runnable); message.obj = token; return sendMessageDelayed(message, delay);
    }
    public final boolean postAtTime(Runnable runnable, long when) { return postAtTime(runnable, null, when); }
    public final boolean postAtTime(Runnable runnable, Object token, long when) {
        Message message = Message.obtain(this, runnable); message.obj = token; return sendMessageAtTime(message, when);
    }
    public final boolean sendMessage(Message message) { return sendMessageDelayed(message, 0); }
    public final boolean sendEmptyMessage(int what) { return sendMessage(obtainMessage(what)); }
    public final boolean sendEmptyMessageDelayed(int what, long delay) { return sendMessageDelayed(obtainMessage(what), delay); }
    public final boolean sendEmptyMessageAtTime(int what, long when) { return sendMessageAtTime(obtainMessage(what), when); }
    public final boolean sendMessageDelayed(Message message, long delay) { return sendMessageAtTime(message, SystemClock.uptimeMillis() + Math.max(0, delay)); }
    public boolean sendMessageAtTime(Message message, long when) {
        synchronized (pending) {
            if (pending.size() >= 1024 || pending.containsKey(message)) throw new IllegalStateException("android_message_limit");
            if (looper.executor.isShutdown()) return false;
            message.target = this; message.when = when;
            ScheduledFuture<?> future = looper.executor.schedule(() -> {
                synchronized (pending) { if (pending.remove(message) == null) return; }
                dispatchMessage(message);
            }, Math.max(0, when - SystemClock.uptimeMillis()), TimeUnit.MILLISECONDS);
            pending.put(message, future); return true;
        }
    }
    private void remove(Predicate<Message> predicate) {
        synchronized (pending) { pending.entrySet().removeIf(entry -> {
            if (!predicate.test(entry.getKey())) return false; entry.getValue().cancel(false); return true;
        }); }
    }
    public final void removeCallbacks(Runnable runnable) { remove(message -> message.callback == runnable); }
    public final void removeCallbacks(Runnable runnable, Object token) { remove(message -> message.callback == runnable && (token == null || message.obj == token)); }
    public final void removeMessages(int what) { remove(message -> message.callback == null && message.what == what); }
    public final void removeMessages(int what, Object token) { remove(message -> message.callback == null && message.what == what && (token == null || message.obj == token)); }
    public final void removeCallbacksAndMessages(Object token) { remove(message -> token == null || message.obj == token); }
    public final boolean hasCallbacks(Runnable runnable) { synchronized (pending) { return pending.keySet().stream().anyMatch(m -> m.callback == runnable); } }
    public final boolean hasMessages(int what) { return hasMessages(what, null); }
    public final boolean hasMessages(int what, Object token) { synchronized (pending) { return pending.keySet().stream().anyMatch(m -> m.callback == null && m.what == what && (token == null || m.obj == token)); } }
}
