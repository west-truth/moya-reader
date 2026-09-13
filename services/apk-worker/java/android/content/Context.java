package android.content;
/** Minimal host context. Unsupported Android services fail explicitly. */
public abstract class Context {
 public static final int MODE_PRIVATE = 0;
 public abstract SharedPreferences getSharedPreferences(String name, int mode);
 public Context getApplicationContext() { return this; }
 public String getPackageName() { return "org.moya.apkworker"; }
 public ClassLoader getClassLoader() { return getClass().getClassLoader(); }
 public Object getSystemService(String name) { throw new UnsupportedOperationException("android_service_unsupported"); }
}
