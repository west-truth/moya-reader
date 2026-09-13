package android.os;

/** In-process messages only; Binder/Parcel transport is deliberately unsupported. */
public final class Message {
    public int what, arg1, arg2;
    public Object obj;
    Handler target;
    Runnable callback;
    long when;
    private boolean asynchronous;
    public Message() {}
    public static Message obtain() { return new Message(); }
    public static Message obtain(Message other) { Message value = obtain(); value.copyFrom(other); return value; }
    public static Message obtain(Handler h) { Message value = obtain(); value.target = h; return value; }
    public static Message obtain(Handler h, Runnable callback) { Message value = obtain(h); value.callback = callback; return value; }
    public static Message obtain(Handler h, int what) { Message value = obtain(h); value.what = what; return value; }
    public static Message obtain(Handler h, int what, Object obj) { Message value = obtain(h, what); value.obj = obj; return value; }
    public static Message obtain(Handler h, int what, int arg1, int arg2) { return obtain(h, what, arg1, arg2, null); }
    public static Message obtain(Handler h, int what, int arg1, int arg2, Object obj) {
        Message value = obtain(h, what, obj); value.arg1 = arg1; value.arg2 = arg2; return value;
    }
    public void copyFrom(Message other) {
        what = other.what; arg1 = other.arg1; arg2 = other.arg2; obj = other.obj;
        target = other.target; callback = other.callback; when = other.when; asynchronous = other.asynchronous;
    }
    public void setTarget(Handler handler) { target = handler; }
    public Handler getTarget() { return target; }
    public Runnable getCallback() { return callback; }
    public long getWhen() { return when; }
    public void sendToTarget() { if (target == null) throw new IllegalStateException("message_target_missing"); target.sendMessage(this); }
    public void setAsynchronous(boolean value) { asynchronous = value; }
    public boolean isAsynchronous() { return asynchronous; }
    public void recycle() { obj = null; callback = null; target = null; }
}
