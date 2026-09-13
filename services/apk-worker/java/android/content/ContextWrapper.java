package android.content;
public class ContextWrapper extends Context {
 protected Context base;
 public ContextWrapper(Context base) { this.base = base; }
 public Context getBaseContext() { return base; }
 protected void attachBaseContext(Context base) { this.base = base; }
 public SharedPreferences getSharedPreferences(String name, int mode) { return base.getSharedPreferences(name, mode); }
}
