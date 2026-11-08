package com.kea.scholar;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.documentfile.provider.DocumentFile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanner;
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.List;

/** The app's bridge to Kea's native parts: the class site, the data folder in the cloud drive, the scanner. */
@CapacitorPlugin(name = "Kea")
public class KeaPlugin extends Plugin {
    private ActivityResultLauncher<IntentSenderRequest> scanLauncher;
    private PluginCall scanCall;

    @Override
    public void load() {
        scanLauncher = getActivity().registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), this::onScanned);
        CheckWorker.schedule(getContext());
        // (Kea started fresh by a Google or Microsoft sign-in coming back: kept for takeOauth.)
        if (!takeOauthIntent(getActivity().getIntent())) takeOpened(getActivity().getIntent());
    }

    // ---------- Files opened with Kea (Open with, Share) ----------
    private JSObject opened;

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (takeOauthIntent(intent)) {
            if (oauthBack == null) return;
            JSObject o = new JSObject();
            o.put("url", oauthBack);
            oauthBack = null;
            notifyListeners("oauth", o, false);
            return;
        }
        if (takeOpened(intent)) notifyListeners("opened", opened, true);
    }

    // ---------- Google and Microsoft sign-in coming back (com.kea.scholar:/oauth?code=...&state=...) ----------
    private String oauthBack;

    /**
     * The browser came back to Kea's own sign-in address: kept for the app, which checks it against the sign-in it
     * started (state, PKCE). True when the intent was under Kea's scheme (anything but /oauth there is ignored).
     */
    private boolean takeOauthIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction()) || intent.getData() == null) return false;
        Uri u = intent.getData();
        if (!getContext().getPackageName().equalsIgnoreCase(u.getScheme())) return false;
        intent.setAction(Intent.ACTION_MAIN);
        intent.setData(null);
        if ("/oauth".equals(u.getPath())) oauthBack = u.toString();
        return true;
    }

    /** The sign-in that came back while Kea wasn't running (once). */
    @PluginMethod
    public void takeOauth(PluginCall call) {
        JSObject r = new JSObject();
        if (oauthBack != null) r.put("url", oauthBack);
        oauthBack = null;
        call.resolve(r);
    }

    /**
     * Google's or Microsoft's sign-in page in a Custom Tab (the phone's browser, with its own saved sign-ins; Kea never
     * sees that password). Only those two sign-in pages. (The Custom Tabs extras, without the support library: a
     * browser that doesn't know them opens the page normally.)
     */
    @PluginMethod
    public void oauthOpen(PluginCall call) {
        String url = call.getString("url", "");
        Uri u = Uri.parse(url == null ? "" : url);
        String host = u.getHost() == null ? "" : u.getHost().toLowerCase();
        if (!"https".equalsIgnoreCase(u.getScheme()) || !("accounts.google.com".equals(host) || "login.microsoftonline.com".equals(host))) {
            call.reject("Kea only opens Google's or Microsoft's sign-in page here.");
            return;
        }
        Intent i = new Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE);
        android.os.Bundle extras = new android.os.Bundle();
        extras.putBinder("android.support.customtabs.extra.SESSION", null);
        i.putExtras(extras);
        i.putExtra("android.support.customtabs.extra.TOOLBAR_COLOR", 0xFF131314);
        i.putExtra("android.support.customtabs.extra.TITLE_VISIBILITY", 1);
        try {
            getActivity().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("There's no browser on this phone to sign in with.");
        }
    }

    /** The code for tokens, at the provider's own token address (Hub.oauthToken): { status, body }. */
    @PluginMethod
    public void oauthToken(PluginCall call) {
        String provider = call.getString("provider", "");
        String body = call.getString("body", "");
        new Thread(() -> {
            try {
                Hub.Answer a = Hub.oauthToken(provider, body);
                JSObject r = new JSObject();
                r.put("status", a.status);
                r.put("body", a.body);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }).start();
    }

    /** The Kea accounts kept on this phone (with their password verifiers): Android's encrypted storage only. */
    @PluginMethod
    public void accountsRead(PluginCall call) {
        new Thread(() -> {
            try {
                JSObject r = new JSObject();
                r.put("text", Hub.accounts(getContext()));
                call.resolve(r);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }).start();
    }

    @PluginMethod
    public void accountsWrite(PluginCall call) {
        String text = call.getString("text", "");
        new Thread(() -> {
            try {
                Hub.keepAccounts(getContext(), text);
                call.resolve();
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }).start();
    }

    /** A file another app handed to Kea: copied where the reader can load it. True when there was one. */
    private boolean takeOpened(Intent intent) {
        if (intent == null) return false;
        String saved = intent.getStringExtra("keaFile");
        if (saved != null) {
            intent.removeExtra("keaFile");
            File f = new File(saved);
            // Only Kea's own downloads (in its documents folder): any app can send this intent, and must not be able
            // to make Kea show (and offer to share) its other private files.
            try {
                String root = docsDir().getCanonicalPath() + File.separator;
                if (!f.getCanonicalPath().startsWith(root)) return false;
            } catch (java.io.IOException e) {
                return false;
            }
            opened = new JSObject();
            opened.put("path", f.getAbsolutePath());
            opened.put("name", f.getName());
            opened.put("type", intent.getStringExtra("keaType") == null ? "" : intent.getStringExtra("keaType"));
            intent.removeExtra("keaFile");
            return true;
        }
        Uri uri = null;
        if (Intent.ACTION_VIEW.equals(intent.getAction())) uri = intent.getData();
        else if (Intent.ACTION_SEND.equals(intent.getAction())) uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (uri == null) return false;
        // Only a file another app shares (content://), never a path (file://) or one of Kea's own files: any app can
        // send this, and must not be able to make Kea copy its private files (cookies, settings) where it can see them.
        if (!"content".equalsIgnoreCase(uri.getScheme()) || ownProvider(uri)) {
            intent.setAction(Intent.ACTION_MAIN);
            return false;
        }
        try (android.content.res.AssetFileDescriptor afd = getContext().getContentResolver().openAssetFileDescriptor(uri, "r")) {
            if (afd == null || insidePrivate(afd.getParcelFileDescriptor())) {
                intent.setAction(Intent.ACTION_MAIN);
                return false;
            }
            String name = displayName(uri);
            if (name == null) name = uri.getLastPathSegment() == null ? "File" : uri.getLastPathSegment();
            String type = getContext().getContentResolver().getType(uri);
            // Every document joins the phone's files (listed under Files), whatever its kind.
            File dir = docsDir();
            dir.mkdirs();
            File out = freeName(dir, name);
            try (InputStream in = afd.createInputStream(); OutputStream os = new FileOutputStream(out)) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            }
            opened = new JSObject();
            opened.put("path", out.getAbsolutePath());
            opened.put("name", name);
            opened.put("type", type == null ? "" : type);
            // (Handled once: a later launch from the home screen doesn't open it again.)
            intent.setAction(Intent.ACTION_MAIN);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** A content address served by Kea itself (its file provider, or any other provider in Kea's own package). */
    private boolean ownProvider(Uri uri) {
        String auth = uri.getAuthority();
        if (auth == null) return true;
        if (auth.equalsIgnoreCase(getContext().getPackageName() + ".fileprovider")) return true;
        try {
            for (String a : auth.split(";")) {
                android.content.pm.ProviderInfo p = getContext().getPackageManager().resolveContentProvider(a, 0);
                if (p != null && getContext().getPackageName().equals(p.packageName)) return true;
            }
        } catch (Exception e) {
            return true;
        }
        return false;
    }

    /**
     * Whether an opened file is really one of Kea's private files (in its data folder, or its own folders on shared
     * storage), however the address was dressed up: the file the descriptor points at is checked, not the address.
     */
    private boolean insidePrivate(android.os.ParcelFileDescriptor pfd) {
        if (pfd == null) return true;
        String real;
        try {
            real = android.system.Os.readlink("/proc/self/fd/" + pfd.getFd());
        } catch (Exception e) {
            return false;
        }
        // (A pipe or socket from another app's provider isn't a file at all.)
        if (real == null || !real.startsWith("/")) return false;
        String pkg = getContext().getPackageName();
        java.util.List<String> roots = new java.util.ArrayList<>();
        roots.add(getContext().getApplicationInfo().dataDir);
        if (Build.VERSION.SDK_INT >= 24 && getContext().getApplicationInfo().deviceProtectedDataDir != null) roots.add(getContext().getApplicationInfo().deviceProtectedDataDir);
        roots.add("/data/data/" + pkg);
        File ext = getContext().getExternalFilesDir(null);
        if (ext != null && ext.getParentFile() != null) roots.add(ext.getParentFile().getPath());
        String canon;
        try {
            canon = new File(real).getCanonicalPath();
        } catch (java.io.IOException e) {
            canon = real;
        }
        for (String r : roots) {
            if (r == null) continue;
            String root;
            try {
                root = new File(r).getCanonicalPath();
            } catch (java.io.IOException e) {
                root = r;
            }
            if (canon.equals(root) || canon.startsWith(root + File.separator) || real.startsWith(r + File.separator)) return true;
        }
        // (Any user's or profile's copy of Kea's data: /data/user/<n>/<package>, /data/user_de/<n>/<package>.)
        return canon.matches("^/data/(user|user_de)/\\d+/" + java.util.regex.Pattern.quote(pkg) + "(/.*)?$") || canon.matches("^/mnt/expand/[^/]+/(user|user_de)/\\d+/" + java.util.regex.Pattern.quote(pkg) + "(/.*)?$");
    }

    /** Kea's colours for class sites (see SiteActivity.theme), kept for the next page opened. */
    @PluginMethod
    public void siteTheme(PluginCall call) {
        Store.plain(getContext()).edit().putString("siteTheme", call.getString("json", "")).apply();
        call.resolve();
    }

    @PluginMethod
    public void takeOpenedFile(PluginCall call) {
        JSObject r = new JSObject();
        if (opened != null) r.put("file", opened);
        opened = null;
        call.resolve(r);
    }

    // ---------- Settings and sign-in ----------
    @PluginMethod
    public void setup(PluginCall call) {
        String home = call.getString("home", "");
        String user = call.getString("user");
        String pass = call.getString("pass");
        boolean newSchool = !ClassSite.host(home).equals(ClassSite.host(Store.home(getContext())));
        Store.plain(getContext()).edit().putString("home", home).apply();
        android.content.SharedPreferences.Editor sec = Store.secure(getContext()).edit();
        // A new school or a new login: the sign-in page is learned again, from the page where this login works (the
        // sign-in that follows: ClassSite.signIn, or the sign-in window), never from a page merely visited.
        if (newSchool || (pass != null && !pass.isEmpty())) sec.remove("loginHost");
        if (pass != null && !pass.isEmpty()) sec.putString("user", user == null ? "" : user).putString("pass", pass);
        else if (newSchool) sec.remove("user").remove("pass");
        sec.apply();
        call.resolve();
    }

    @PluginMethod
    public void state(PluginCall call) {
        new Thread(() -> {
            JSObject r = new JSObject();
            r.put("home", Store.home(getContext()));
            r.put("hasLogin", !Store.secure(getContext()).getString("pass", "").isEmpty());
            r.put("signedIn", ClassSite.signedIn(getContext()));
            String tree = Store.plain(getContext()).getString("tree", "");
            r.put("dataFolder", tree.isEmpty() ? Store.plain(getContext()).getString("dataFile", "") : tree);
            r.put("dataFileOnly", tree.isEmpty() && !Store.plain(getContext()).getString("dataFile", "").isEmpty());
            JSArray chosen = new JSArray();
            for (String f : KEA_FILES) if (!tree.isEmpty() || !Store.plain(getContext()).getString("file:" + f, "").isEmpty()) chosen.put(f);
            r.put("files", chosen);
            String held = tree.isEmpty() ? Store.plain(getContext()).getString("file:kea-data.json", Store.plain(getContext()).getString("dataFile", "")) : tree;
            r.put("drive", held.isEmpty() ? "" : driveOf(Uri.parse(held)));
            r.put("notifications", Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED);
            call.resolve(r);
        }).start();
    }

    /** Sign in by itself; if that doesn't get through and `show` is set, the student finishes in Kea's window. */
    @PluginMethod
    public void signIn(PluginCall call) {
        boolean show = call.getBoolean("show", true);
        ClassSite.signIn(getContext(), (ok) -> {
            if (ok || !show) {
                JSObject r = new JSObject();
                r.put("signedIn", ok);
                call.resolve(r);
                return;
            }
            SiteActivity.signInListener = (ok2) -> {
                JSObject r = new JSObject();
                r.put("signedIn", ok2);
                call.resolve(r);
            };
            Intent i = new Intent(getContext(), SiteActivity.class).putExtra("mode", "signin").putExtra("url", Store.home(getContext()));
            getActivity().startActivity(i);
        });
    }

    /**
     * GET a class-site address with the session (signing in by itself when needed). Only the class site itself or its
     * sign-in page, over https: the school's cookies go with it, so no other address is ever fetched.
     */
    @PluginMethod
    public void get(PluginCall call) {
        String url = call.getString("url");
        if (!ClassSite.mayRequest(getContext(), url)) {
            call.reject("Kea only reads your class site.");
            return;
        }
        new Thread(() -> {
            try {
                ClassSite.Answer a = ClassSite.get(getContext(), url);
                JSObject r = new JSObject();
                r.put("status", a.status);
                r.put("body", a.body);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        if (url == null) {
            call.reject("No address");
            return;
        }
        // The class site (https) opens in Kea's class-site window, signed in; any other web, mail or phone address in
        // the phone's own apps. Nothing else (file:, content:, intent: addresses) is opened.
        Uri u = Uri.parse(url);
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
        if (Domains.httpsOn(url, ClassSite.host(Store.home(getContext())))) {
            getActivity().startActivity(new Intent(getContext(), SiteActivity.class).putExtra("mode", "open").putExtra("url", url));
        } else if (scheme.equals("https") || scheme.equals("http") || scheme.equals("mailto") || scheme.equals("tel")) {
            Intent view = new Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE);
            view.setSelector(null);
            view.setComponent(null);
            try {
                getActivity().startActivity(view);
            } catch (Exception e) {
                call.reject("No app on this phone opens that address.");
                return;
            }
        } else {
            call.reject("Kea doesn't open that kind of address.");
            return;
        }
        call.resolve();
    }

    /** The assignment's own hand-in page with the file given to its upload box. The student presses Submit. */
    @PluginMethod
    public void handIn(PluginCall call) {
        String url = call.getString("url");
        String file = call.getString("file");
        // Only a page on the class site, and only one of Kea's own scans or files for its upload box.
        Uri given = file == null ? null : ownUri(file);
        if (!Domains.httpsOn(url, ClassSite.host(Store.home(getContext()))) || (file != null && given == null)) {
            call.reject("Kea only hands in its own files on your class site.");
            return;
        }
        getActivity().startActivity(new Intent(getContext(), SiteActivity.class).putExtra("mode", "handin").putExtra("url", url).putExtra("file", given == null ? null : given.toString()));
        call.resolve();
    }

    /** Where Kea's own files are: scans, documents opened in Kea, and the library (textbooks). */
    private File[] ownDirs() {
        return new File[] { scansDir(), docsDir(), libraryDir() };
    }

    /** One of Kea's own files (scans, documents, the library), by its path; null for anything else on the phone. */
    private File ownAny(String path) {
        if (path == null || path.isEmpty()) return null;
        try {
            File f = new File(path).getCanonicalFile();
            for (File d : ownDirs()) if (f.getPath().startsWith(d.getCanonicalPath() + File.separator)) return f;
        } catch (java.io.IOException ignored) {
        }
        return null;
    }

    /** The file-provider folder names (res/xml/file_paths.xml) for Kea's own folders. */
    private File providerDir(String name) {
        switch (name) {
            case "kea_scans": return scansDir();
            case "kea_docs": return docsDir();
            case "kea_library": return libraryDir();
            default: return null;
        }
    }

    /**
     * One of Kea's own files as a content address to hand to another app or a hand-in page: a path to a file in Kea's
     * own folders, or Kea's file-provider address for one. Null for anything else (another path, another app's
     * address, Kea's private settings): nothing else of Kea's can be shared from the app.
     */
    private Uri ownUri(String file) {
        if (file == null || file.isEmpty()) return null;
        String fp = getContext().getPackageName() + ".fileprovider";
        try {
            if (file.startsWith("/")) {
                File f = ownAny(file);
                return f == null || !f.isFile() ? null : FileProvider.getUriForFile(getContext(), fp, f);
            }
            Uri u = Uri.parse(file);
            if (!"content".equalsIgnoreCase(u.getScheme()) || !fp.equals(u.getAuthority())) return null;
            List<String> seg = u.getPathSegments();
            if (seg.size() < 2) return null;
            File dir = providerDir(seg.get(0));
            if (dir == null) return null;
            File f = ownAny(new File(dir, android.text.TextUtils.join("/", seg.subList(1, seg.size()))).getPath());
            return f == null || !f.isFile() ? null : FileProvider.getUriForFile(getContext(), fp, f);
        } catch (Exception e) {
            return null;
        }
    }

    /** Share a scan (or any Kea file) through Android's share sheet: email, Messages, Drive, anything. */
    @PluginMethod
    public void share(PluginCall call) {
        Uri uri = ownUri(call.getString("file", ""));
        if (uri == null) {
            call.reject("Only Kea's own files can be shared from here.");
            return;
        }
        Intent send = new Intent(Intent.ACTION_SEND).setType("application/pdf").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        String title = call.getString("name", "");
        if (!title.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, title);
        getActivity().startActivity(Intent.createChooser(send, "Share"));
        call.resolve();
    }

    /** Save a copy of a scan in the phone's Downloads, under a name the student chose. */
    @PluginMethod
    public void saveCopy(PluginCall call) {
        Uri from = ownUri(call.getString("file", ""));
        if (from == null) {
            call.reject("Only Kea's own files can be saved from here.");
            return;
        }
        String name = call.getString("name", "Scan").replaceAll("[^A-Za-z0-9 ._()#-]", "").trim();
        if (!name.toLowerCase().endsWith(".pdf")) name += ".pdf";
        final String fileName = name;
        new Thread(() -> {
            try {
                android.content.ContentValues v = new android.content.ContentValues();
                v.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, fileName);
                v.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "application/pdf");
                Uri to;
                if (Build.VERSION.SDK_INT >= 29) {
                    v.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, android.os.Environment.DIRECTORY_DOWNLOADS);
                    to = getContext().getContentResolver().insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                } else {
                    File dir = android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS);
                    to = Uri.fromFile(new File(dir, fileName));
                }
                try (InputStream in = getContext().getContentResolver().openInputStream(from); OutputStream os = getContext().getContentResolver().openOutputStream(to)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                }
                JSObject r = new JSObject();
                r.put("name", fileName);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        }).start();
    }

    // ---------- Notifications ----------
    @PluginMethod
    public void watch(PluginCall call) {
        Store.plain(getContext()).edit().putString("watch", call.getData().toString()).apply();
        CheckWorker.schedule(getContext());
        call.resolve();
    }

    /** Which notifications the student wants, quiet hours, and how often Kea checks (CheckWorker.prefs). */
    @PluginMethod
    public void setNotify(PluginCall call) {
        Store.plain(getContext()).edit().putString("notify", call.getData().toString()).apply();
        CheckWorker.schedule(getContext());
        call.resolve();
    }

    /** A reply to a Canvas conversation, from Kea's Inbox. */
    @PluginMethod
    public void reply(PluginCall call) {
        String conv = call.getString("conv", ""), text = call.getString("text", "");
        // (A conversation is a number: nothing else is put into the class-site address the reply is posted to.)
        if (!conv.matches("\\d{1,20}") || text.trim().isEmpty()) {
            call.reject("Nothing to send.");
            return;
        }
        new Thread(() -> {
            try {
                android.net.Uri base = android.net.Uri.parse(Store.home(getContext()));
                String post = base.buildUpon().encodedPath("/api/v1/conversations/" + conv + "/add_message").clearQuery().build().toString();
                String form = "body=" + java.net.URLEncoder.encode(text.trim(), "UTF-8");
                ClassSite.Answer a = ClassSite.postForm(post, form);
                if (ClassSite.needsSignIn(a) && ClassSite.signInBlocking(getContext(), 60)) a = ClassSite.postForm(post, form);
                if (a.status >= 200 && a.status < 300) call.resolve();
                else call.reject("The class site didn't take the reply (" + a.status + "). Try it on the class site.");
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void allowNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(getActivity(), new String[]{Manifest.permission.POST_NOTIFICATIONS}, 42);
        }
        call.resolve();
    }

    @PluginMethod
    public void checkNow(PluginCall call) {
        new Thread(() -> {
            try {
                List<JSONObject> fresh = CheckWorker.check(getContext(), false);
                JSObject r = new JSObject();
                r.put("count", fresh.size());
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void phoneInbox(PluginCall call) {
        JSObject r = new JSObject();
        try {
            r.put("items", new JSArray(Store.plain(getContext()).getString("phoneInbox", "[]")));
        } catch (Exception e) {
            r.put("items", new JSArray());
        }
        call.resolve(r);
    }

    // ---------- The data folder in the cloud drive ----------
    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, i, "onFolder");
    }

    @ActivityCallback
    private void onFolder(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("No folder chosen");
            return;
        }
        Uri tree = result.getData().getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (SecurityException e) {
            // A folder that can only be read: the phone still shows everything, its checkmarks just stay on the phone.
            getContext().getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        }
        // Kea's files may be in the folder itself or a folder or two below it (Kea → School): found once, remembered.
        DocumentFile root = DocumentFile.fromTreeUri(getContext(), tree);
        String base = locate(root, 0);
        if (base == null) {
            call.reject("That folder doesn't have Kea's files in it. Choose the Kea folder your PC syncs (in it: School → kea-data.json).");
            return;
        }
        Store.plain(getContext()).edit().putString("tree", tree.toString()).putString("treeBase", base).apply();
        JSObject r = new JSObject();
        r.put("folder", tree.toString());
        r.put("base", base);
        r.put("from", driveOf(tree));
        call.resolve(r);
    }

    /** Where kea-data.json is under a chosen folder ("" for the folder itself, "School", "Kea/School"), or null. */
    private String locate(DocumentFile dir, int depth) {
        if (dir == null || !dir.isDirectory()) return null;
        DocumentFile[] list = dir.listFiles();
        for (DocumentFile f : list) if (f.isFile() && "kea-data.json".equals(f.getName())) return "";
        if (depth >= 2) return null;
        // (The School profile first, then any other folder.)
        java.util.Arrays.sort(list, (a, b) -> Boolean.compare(!"School".equals(a.getName()), !"School".equals(b.getName())));
        for (DocumentFile f : list) {
            if (!f.isDirectory() || f.getName() == null || f.getName().startsWith(".")) continue;
            String below = locate(f, depth + 1);
            if (below != null) return below.isEmpty() ? f.getName() : f.getName() + "/" + below;
        }
        return null;
    }

    /** Forget the pairing with the PC (the folder or files chosen): the phone's own files and scans stay. */
    @PluginMethod
    public void unpair(PluginCall call) {
        android.content.SharedPreferences.Editor e = Store.plain(getContext()).edit().remove("tree").remove("treeBase").remove("dataFile").remove("libSig").remove("watch");
        for (String f : KEA_FILES) e.remove("file:" + f);
        e.apply();
        call.resolve();
    }

    // ---------- Kea account: sync through the Kea Hub (Hub.java) ----------

    /** The Hub's address, whether this phone is signed in (the token itself never leaves Java), and where files go. */
    @PluginMethod
    public void hubState(PluginCall call) {
        new Thread(() -> {
            JSObject r = new JSObject();
            r.put("url", Hub.url(getContext()));
            try {
                r.put("signedIn", !Hub.token(getContext()).isEmpty());
            } catch (Exception e) {
                r.put("signedIn", false);
            }
            r.put("email", Hub.email(getContext()));
            r.put("root", libraryDir().getAbsolutePath());
            call.resolve(r);
        }).start();
    }

    @PluginMethod
    public void hubSetUrl(PluginCall call) {
        Hub.setUrl(getContext(), call.getString("url", ""));
        call.resolve();
    }

    /** One call to the Hub's API: { status, body, version }. Never rejects for an HTTP error; the app reads `status`. */
    @PluginMethod
    public void hubRequest(PluginCall call) {
        String method = call.getString("method", "GET");
        String path = call.getString("path", "");
        String body = call.getString("body");
        String type = call.getString("contentType");
        boolean auth = call.getBoolean("auth", true);
        boolean keepToken = call.getBoolean("keepToken", false);
        String ifMatch = call.getString("ifMatch");
        boolean ifNoneMatch = call.getBoolean("ifNoneMatch", false);
        int connectMs = call.getInt("connectMs", 0);
        int readMs = call.getInt("readMs", 0);
        new Thread(() -> {
            try {
                Hub.Answer a = Hub.request(getContext(), method, path, body, type, auth, ifMatch, ifNoneMatch, keepToken, connectMs, readMs);
                JSObject r = new JSObject();
                r.put("status", a.status);
                r.put("body", a.body);
                r.put("version", a.etag);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }).start();
    }

    /** Signed out: the token is forgotten here (the app asks the Hub to end the session first). */
    @PluginMethod
    public void hubForget(PluginCall call) {
        Hub.forget(getContext());
        call.resolve();
    }

    /** A file from Kea storage into the phone's library folder (textbooks), at `to` inside it. */
    @PluginMethod
    public void hubDownload(PluginCall call) {
        String path = call.getString("path", "");
        String to = call.getString("to", "");
        long size = call.getData().optLong("size", -1);
        String sha = call.getString("sha256", "");
        new Thread(() -> {
            try {
                JSONObject j = Hub.download(getContext(), path, Hub.inside(libraryDir(), to), size, sha);
                call.resolve(JSObject.fromJSONObject(j));
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }).start();
    }

    /** Remove a file from the phone's library folder (deleted on the PC). */
    @PluginMethod
    public void hubRemoveLocal(PluginCall call) {
        String to = call.getString("to", "");
        new Thread(() -> {
            try {
                File f = Hub.inside(libraryDir(), to);
                f.delete();
                // An emptied class folder goes too.
                File dir = f.getParentFile();
                String[] left = dir == null ? null : dir.list();
                if (left != null && left.length == 0 && !dir.equals(libraryDir())) dir.delete();
                call.resolve();
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()));
            }
        }).start();
    }

    /**
     * Kea's files chosen by themselves, for drives whose Android app can't share a whole folder (Google Drive,
     * OneDrive): kea-data.json, kea-library.zip and phone.json, picked together once. Each is held by name, and read
     * (always its newest copy) or, for phone.json, written from then on.
     */
    @PluginMethod
    public void pickFiles(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        // Choosing again from the same drive: the picker starts where the files were last time.
        String drive = call.getString("drive", "");
        String before = Store.plain(getContext()).getString("file:kea-data.json", "");
        if (Build.VERSION.SDK_INT >= 26 && !before.isEmpty() && driveOf(Uri.parse(before)).equals(drive)) i.putExtra(android.provider.DocumentsContract.EXTRA_INITIAL_URI, Uri.parse(before));
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, i, "onFiles");
    }

    /** The older single-file choice (kea-data.json alone): the same picker. */
    @PluginMethod
    public void pickDataFile(PluginCall call) {
        pickFiles(call);
    }

    private static final String[] KEA_FILES = { "kea-data.json", "kea-library.zip", "phone.json" };

    /** The drives the PC can sync Kea through, by their Android apps. */
    private static final String[][] DRIVE_APPS = { { "google", "com.google.android.apps.docs" }, { "onedrive", "com.microsoft.skydrive" }, { "dropbox", "com.dropbox.android" } };

    /**
     * Where a chosen file or folder lives, by the app that handed it over: "google", "onedrive", "dropbox", "phone"
     * (the phone's own storage), "downloads" (a copy downloaded once, which never updates) or "other".
     */
    static String driveOf(Uri u) {
        String a = u == null || u.getAuthority() == null ? "" : u.getAuthority();
        if (a.startsWith("com.google.android.apps.docs")) return "google";
        if (a.startsWith("com.microsoft.skydrive")) return "onedrive";
        if (a.startsWith("com.dropbox")) return "dropbox";
        if (a.startsWith("com.android.providers.downloads")) return "downloads";
        if (a.equals("com.android.externalstorage.documents") || a.startsWith("com.android.providers.media")) return "phone";
        return a.isEmpty() ? "" : "other";
    }

    /** Which drive apps are on the phone (a drive's files can only be chosen through its app). */
    @PluginMethod
    public void drives(PluginCall call) {
        JSObject r = new JSObject();
        PackageManager pm = getContext().getPackageManager();
        for (String[] d : DRIVE_APPS) {
            boolean has;
            try {
                pm.getPackageInfo(d[1], 0);
                has = true;
            } catch (PackageManager.NameNotFoundException e) {
                has = false;
            }
            r.put(d[0], has);
        }
        call.resolve(r);
    }

    /** Which of Kea's files a chosen file is, by its name (a drive may add " (1)" to a copy): null when none. */
    private static String keaFile(String name) {
        if (name == null) return null;
        String plain = name.replaceAll(" \\(\\d+\\)(?=\\.[a-z]+$)", "");
        for (String f : KEA_FILES) if (plain.equals(f)) return f;
        return null;
    }

    @ActivityCallback
    private void onFiles(PluginCall call, ActivityResult result) {
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            call.reject("No file chosen");
            return;
        }
        List<Uri> uris = new java.util.ArrayList<>();
        if (data.getClipData() != null) for (int k = 0; k < data.getClipData().getItemCount(); k++) uris.add(data.getClipData().getItemAt(k).getUri());
        else if (data.getData() != null) uris.add(data.getData());
        JSArray found = new JSArray();
        android.content.SharedPreferences.Editor ed = Store.plain(getContext()).edit();
        for (Uri u : uris) {
            String which = keaFile(displayName(u));
            if (which == null) continue;
            try {
                getContext().getContentResolver().takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (SecurityException e) {
                try {
                    getContext().getContentResolver().takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (SecurityException e2) {
                    // (This session only: chosen again next time.)
                }
            }
            ed.putString("file:" + which, u.toString());
            if ("kea-data.json".equals(which)) ed.putString("dataFile", u.toString());
            found.put(which);
        }
        ed.apply();
        if (found.length() == 0) {
            call.reject("None of Kea's files were chosen. In your drive, open Kea, then your profile folder (School), and select kea-data.json, kea-library.zip and phone.json.");
            return;
        }
        JSObject r = new JSObject();
        r.put("files", found);
        r.put("from", driveOf(Uri.parse(Store.plain(getContext()).getString("file:" + found.optString(0, "kea-data.json"), ""))));
        call.resolve(r);
    }

    private String displayName(Uri u) {
        try (android.database.Cursor c = getContext().getContentResolver().query(u, new String[] { android.provider.OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception e) {
            // (Unnamed: not one of Kea's files.)
        }
        return null;
    }

    /** A chosen file's size and last change, as a short signature (to tell a new copy from the one already read). */
    private String signature(Uri u) {
        try (android.database.Cursor c = getContext().getContentResolver().query(u, new String[] { android.provider.OpenableColumns.SIZE, android.provider.DocumentsContract.Document.COLUMN_LAST_MODIFIED }, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getLong(0) + ":" + c.getLong(1);
        } catch (Exception e) {
            // (No details: always read it.)
        }
        return "";
    }

    /** A relative path inside a folder: no empty, "." or ".." parts, not absolute, no backslashes. */
    static boolean plainRel(String rel) {
        if (rel == null || rel.isEmpty() || rel.startsWith("/") || rel.contains("\\") || rel.indexOf(0) >= 0) return false;
        for (String part : rel.split("/", -1)) if (part.isEmpty() || part.equals(".") || part.equals("..")) return false;
        return true;
    }

    /** A file inside the chosen folder by its path ("kea-data.json", "Textbooks/BIO1112/x.pdf"). */
    private DocumentFile find(String rel) {
        String tree = Store.plain(getContext()).getString("tree", "");
        if (tree.isEmpty()) return null;
        DocumentFile f = DocumentFile.fromTreeUri(getContext(), Uri.parse(tree));
        String base = Store.plain(getContext()).getString("treeBase", "");
        if (!base.isEmpty()) rel = base + "/" + rel;
        for (String part : rel.split("/")) {
            if (f == null || part.isEmpty()) continue;
            f = f.findFile(part);
        }
        return f;
    }

    /** One of Kea's files: in the chosen folder, or chosen by itself. Null when it's neither. */
    private Uri fileUri(String name) {
        DocumentFile f = find(name);
        if (f != null && f.exists()) return f.getUri();
        String one = Store.plain(getContext()).getString("file:" + name, "");
        if (one.isEmpty() && "kea-data.json".equals(name)) one = Store.plain(getContext()).getString("dataFile", "");
        return one.isEmpty() ? null : Uri.parse(one);
    }

    @PluginMethod
    public void readFile(PluginCall call) {
        String rel = call.getString("path", "kea-data.json");
        if (!plainRel(rel)) {
            call.reject("not found");
            return;
        }
        new Thread(() -> {
            try {
                Uri uri = fileUri(rel);
                if (uri == null) {
                    boolean none = Store.plain(getContext()).getString("tree", "").isEmpty() && Store.plain(getContext()).getString("file:kea-data.json", "").isEmpty() && Store.plain(getContext()).getString("dataFile", "").isEmpty();
                    call.reject(none ? "No Kea folder or file chosen yet" : "not found");
                    return;
                }
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                JSObject r = new JSObject();
                r.put("text", out.toString("UTF-8"));
                r.put("modified", 0);
                r.put("sig", signature(uri));
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        }).start();
    }

    /** Write the phone's own file (phone.json: what it checked off, read and studied), for Kea on the PC. */
    @PluginMethod
    public void writeFile(PluginCall call) {
        String name = call.getString("path", "phone.json");
        String text = call.getString("text", "");
        // (The phone only ever writes its own file into the Kea folder.)
        if (!"phone.json".equals(name)) {
            call.reject("Kea only writes phone.json.");
            return;
        }
        new Thread(() -> {
            try {
                Uri uri = fileUri(name);
                String tree = Store.plain(getContext()).getString("tree", "");
                if (uri == null && !tree.isEmpty()) {
                    String base = Store.plain(getContext()).getString("treeBase", "");
                    DocumentFile dir = base.isEmpty() ? DocumentFile.fromTreeUri(getContext(), Uri.parse(tree)) : find("");
                    DocumentFile f = dir == null ? null : dir.createFile("application/json", name);
                    if (f != null) uri = f.getUri();
                }
                if (uri == null) {
                    call.reject("phone.json isn't chosen yet");
                    return;
                }
                try (OutputStream os = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                    os.write(text.getBytes("UTF-8"));
                }
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        }).start();
    }

    private static String readAll(File f) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (InputStream in = new java.io.FileInputStream(f)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
        return out.toString("UTF-8");
    }

    /** Where the library (textbooks, question pictures) is unpacked on the phone. */
    private File libraryDir() {
        return new File(getContext().getFilesDir(), "library");
    }

    /**
     * Unpack kea-library.zip when the PC has written a new one: only the files that changed are written, and files the
     * new one no longer has are removed. Reports progress ("library" events). { root, changed, files, missing, error }.
     */
    @PluginMethod
    public void syncLibrary(PluginCall call) {
        new Thread(() -> {
            JSObject r = new JSObject();
            File root = libraryDir();
            r.put("root", root.getAbsolutePath());
            try {
                Uri uri = fileUri("kea-library.zip");
                if (uri == null) {
                    r.put("changed", false);
                    r.put("missing", true);
                    call.resolve(r);
                    return;
                }
                String sig = signature(uri);
                // The size the PC wrote: a zip the drive app is still downloading would unpack short and remove
                // textbooks it seems not to have, so it waits for the next sync.
                long want = call.getData().optLong("size", 0);
                if (want > 0 && !sig.isEmpty() && Long.parseLong(sig.substring(0, sig.indexOf(':'))) != want) {
                    r.put("changed", false);
                    r.put("error", "The textbooks file is still downloading.");
                    call.resolve(r);
                    return;
                }
                if (!sig.isEmpty() && sig.equals(Store.plain(getContext()).getString("libSig", "")) && root.isDirectory()) {
                    r.put("changed", false);
                    call.resolve(r);
                    return;
                }
                root.mkdirs();
                File manifestFile = new File(root, ".manifest.json");
                JSONObject manifest = new JSONObject();
                if (manifestFile.exists()) {
                    try {
                        manifest = new JSONObject(readAll(manifestFile));
                    } catch (Exception e) {
                        // (Unreadable: every file is written again.)
                    }
                }
                JSONObject next = new JSONObject();
                long total = 0;
                int count = 0;
                try (InputStream in = getContext().getContentResolver().openInputStream(uri); java.util.zip.ZipInputStream zip = new java.util.zip.ZipInputStream(new java.io.BufferedInputStream(in, 1 << 16))) {
                    java.util.zip.ZipEntry e;
                    byte[] buf = new byte[1 << 16];
                    while ((e = zip.getNextEntry()) != null) {
                        String name = e.getName();
                        if (e.isDirectory() || name.contains("..")) continue;
                        File out = new File(root, name);
                        String crc = Long.toString(e.getCrc());
                        next.put(name, crc);
                        count++;
                        if (crc.equals(manifest.optString(name)) && out.exists() && out.length() == e.getSize()) {
                            zip.closeEntry();
                            continue;
                        }
                        out.getParentFile().mkdirs();
                        File tmp = new File(out.getPath() + ".part");
                        try (OutputStream os = new FileOutputStream(tmp)) {
                            int n;
                            while ((n = zip.read(buf)) > 0) {
                                os.write(buf, 0, n);
                                total += n;
                            }
                        }
                        out.delete();
                        tmp.renameTo(out);
                        JSObject p = new JSObject();
                        p.put("files", count);
                        p.put("bytes", total);
                        p.put("name", name);
                        notifyListeners("library", p);
                    }
                }
                // Files the new library doesn't have any more.
                java.util.Iterator<String> old = manifest.keys();
                while (old.hasNext()) {
                    String name = old.next();
                    if (!next.has(name)) new File(root, name).delete();
                }
                try (OutputStream os = new FileOutputStream(manifestFile)) {
                    os.write(next.toString().getBytes("UTF-8"));
                }
                Store.plain(getContext()).edit().putString("libSig", sig).apply();
                r.put("changed", true);
                r.put("files", count);
                call.resolve(r);
            } catch (Exception e) {
                r.put("changed", false);
                r.put("error", String.valueOf(e.getMessage()));
                call.resolve(r);
            }
        }).start();
    }

    /** Open a file (a textbook PDF) in another app: from the chosen folder, or from the phone's library. */
    /** One of Kea's files in another app on the phone (Android asks which), for anything Kea can't show itself. */
    @PluginMethod
    public void openWith(PluginCall call) {
        String path = call.getString("path", "");
        // (Only Kea's own files: scans, documents and the library. Never its settings or anything else it keeps.)
        File f = ownAny(path);
        Uri uri = f == null ? null : ownUri(f.getPath());
        if (f == null || !f.exists() || uri == null) {
            call.reject("That file isn't on the phone.");
            return;
        }
        String ext = android.webkit.MimeTypeMap.getFileExtensionFromUrl(Uri.fromFile(f).toString()).toLowerCase();
        String type = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, type == null ? "*/*" : type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            getActivity().startActivity(Intent.createChooser(i, "Open with"));
            call.resolve();
        } catch (Exception e) {
            call.reject("No app on this phone opens this kind of file.");
        }
    }

    @PluginMethod
    public void openFile(PluginCall call) {
        String rel = call.getString("path", "");
        if (!plainRel(rel)) {
            call.reject("That file isn't on the phone yet.");
            return;
        }
        DocumentFile f = find(rel);
        Uri uri = f != null && f.exists() ? f.getUri() : null;
        if (uri == null) {
            try {
                File local = Hub.inside(libraryDir(), rel);
                if (local.exists()) uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", local);
            } catch (Exception ignored) {
                // (Not inside the library.)
            }
        }
        if (uri == null) {
            call.reject("That file isn't on the phone yet.");
            return;
        }
        Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/pdf").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        getActivity().startActivity(Intent.createChooser(i, "Open with"));
        call.resolve();
    }

    // ---------- Scanning ----------
    @PluginMethod
    public void scan(PluginCall call) {
        GmsDocumentScannerOptions opts = new GmsDocumentScannerOptions.Builder()
            .setGalleryImportAllowed(true)
            .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_PDF)
            .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
            .build();
        GmsDocumentScanner scanner = GmsDocumentScanning.getClient(opts);
        scanCall = call;
        scanner.getStartScanIntent(getActivity())
            .addOnSuccessListener((sender) -> scanLauncher.launch(new IntentSenderRequest.Builder(sender).build()))
            .addOnFailureListener((e) -> {
                scanCall = null;
                call.reject("The scanner couldn't start: " + e.getMessage());
            });
    }

    // ---------- The phone's own files: scans and PDFs (kept in the app's storage, listed under Files) ----------
    private File scansDir() {
        return new File(getContext().getFilesDir(), "scans");
    }

    private File docsDir() {
        return docsDir(getContext());
    }

    /** Where documents opened in Kea are kept (any kind: PDFs, Word, slides, spreadsheets, books…). */
    static File docsDir(android.content.Context ctx) {
        return new File(ctx.getFilesDir(), "docs");
    }

    /** A file name in `dir` that isn't taken yet ("Lab 3.pdf", then "Lab 3 (2).pdf"). */
    static File freeName(File dir, String name) {
        String clean = name.replaceAll("[\\\\/:*?\"<>|]+", " ").replaceAll("\\s+", " ").trim();
        if (clean.isEmpty() || clean.equals(".pdf")) clean = "Document.pdf";
        int dot = clean.lastIndexOf('.');
        String stem = dot > 0 ? clean.substring(0, dot) : clean, ext = dot > 0 ? clean.substring(dot) : "";
        File f = new File(dir, clean);
        for (int n = 2; f.exists(); n++) f = new File(dir, stem + " (" + n + ")" + ext);
        return f;
    }

    /** Only a file in Kea's own scans or PDFs (never anything else on the phone). */
    private File ownFile(String path) {
        if (path == null) return null;
        try {
            File f = new File(path).getCanonicalFile();
            for (File d : new File[] { scansDir(), docsDir() }) if (f.getPath().startsWith(d.getCanonicalPath() + File.separator)) return f;
        } catch (java.io.IOException ignored) {
        }
        return null;
    }

    /** Every scan and PDF on the phone: [{ path, name, size, modified, kind }], newest first. */
    @PluginMethod
    public void listFiles(PluginCall call) {
        JSArray out = new JSArray();
        java.util.List<File> all = new java.util.ArrayList<>();
        for (File d : new File[] { scansDir(), docsDir() }) {
            File[] list = d.listFiles();
            if (list != null) for (File f : list) if (f.isFile() && !f.getName().endsWith(".part")) all.add(f);
        }
        all.sort((a, b) -> Long.compare(b.lastModified(), a.lastModified()));
        for (File f : all) {
            JSObject o = new JSObject();
            o.put("path", f.getAbsolutePath());
            o.put("name", f.getName());
            o.put("size", f.length());
            o.put("modified", f.lastModified());
            o.put("kind", f.getParentFile().getName().equals("scans") ? "scan" : "file");
            out.put(o);
        }
        JSObject r = new JSObject();
        r.put("files", out);
        call.resolve(r);
    }

    /** Choose a PDF anywhere (the phone, Drive, Downloads…): copied into Kea's files and opened. */
    @PluginMethod
    public void pickPdf(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("application/pdf");
        startActivityForResult(call, i, "onPdf");
    }

    /** Choose any file (a document, slides, a spreadsheet, a book, a picture…): copied into Kea's files and opened. */
    @PluginMethod
    public void pickFile(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        startActivityForResult(call, i, "onPdf");
    }

    @ActivityCallback
    private void onPdf(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("No file chosen");
            return;
        }
        Uri uri = result.getData().getData();
        new Thread(() -> {
            try {
                String name = displayName(uri);
                String type = getContext().getContentResolver().getType(uri);
                if (name == null) name = type != null && type.contains("pdf") ? "Document.pdf" : "Document";
                if (type != null && type.contains("pdf") && !name.toLowerCase().endsWith(".pdf")) name += ".pdf";
                File dir = docsDir();
                dir.mkdirs();
                File out = freeName(dir, name);
                try (InputStream in = getContext().getContentResolver().openInputStream(uri); OutputStream os = new FileOutputStream(out)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                }
                JSObject r = new JSObject();
                r.put("path", out.getAbsolutePath());
                r.put("name", out.getName());
                r.put("type", type == null ? "" : type);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        }).start();
    }

    /** Rename one of Kea's files (the name only; it stays where it is). */
    @PluginMethod
    public void renameFile(PluginCall call) {
        File f = ownFile(call.getString("path"));
        String name = call.getString("name", "").trim();
        if (f == null || name.isEmpty()) {
            call.reject("That file can't be renamed.");
            return;
        }
        // (It keeps its kind: the old extension goes back on when the new name has none of its own.)
        String old = f.getName(), ext = old.lastIndexOf('.') > 0 ? old.substring(old.lastIndexOf('.')) : "";
        if (!ext.isEmpty() && !name.toLowerCase().endsWith(ext.toLowerCase())) name += ext;
        File to = freeName(f.getParentFile(), name);
        if (!f.renameTo(to)) {
            call.reject("Kea couldn't rename it.");
            return;
        }
        JSObject r = new JSObject();
        r.put("path", to.getAbsolutePath());
        r.put("name", to.getName());
        call.resolve(r);
    }

    /** Write over one of Kea's own scans or PDFs (pages added to it): written beside it first, then swapped in. */
    @PluginMethod
    public void replaceFile(PluginCall call) {
        File f = ownFile(call.getString("path"));
        String data = call.getString("data", "");
        if (f == null || !f.isFile() || data.isEmpty()) {
            call.reject("That file can't be changed.");
            return;
        }
        new Thread(() -> {
            File part = new File(f.getPath() + ".part");
            try {
                byte[] bytes = android.util.Base64.decode(data, android.util.Base64.DEFAULT);
                try (OutputStream os = new FileOutputStream(part)) {
                    os.write(bytes);
                    os.flush();
                }
                if (!part.renameTo(f)) {
                    // (Some file systems won't rename over a file.)
                    if (!f.delete() || !part.renameTo(f)) throw new java.io.IOException("Kea couldn't save the pages.");
                }
                JSObject r = new JSObject();
                r.put("path", f.getAbsolutePath());
                r.put("size", f.length());
                call.resolve(r);
            } catch (Exception e) {
                part.delete();
                call.reject(e.getMessage());
            }
        }).start();
    }

    /** Delete one of Kea's files (only Kea's own scans and PDFs). */
    @PluginMethod
    public void deleteFile(PluginCall call) {
        File f = ownFile(call.getString("path"));
        if (f == null || !f.delete()) {
            call.reject("Kea couldn't delete it.");
            return;
        }
        call.resolve();
    }

    // ---------- Reading aloud (ReadAloud does the reading; this lists voices and passes the reader's controls) ----------
    private android.speech.tts.TextToSpeech voiceList;
    private boolean voiceListReady;

    /** A text-to-speech for listing voices and reading a flashcard side, made once. */
    private void withVoices(Runnable then) {
        if (voiceList != null && voiceListReady) {
            then.run();
            return;
        }
        if (voiceList != null) voiceList.shutdown();
        voiceList = new android.speech.tts.TextToSpeech(getContext(), (status) -> {
            voiceListReady = status == android.speech.tts.TextToSpeech.SUCCESS;
            then.run();
        });
    }

    private static List<ReadAloud.Item> itemsOf(PluginCall call) {
        List<ReadAloud.Item> out = new java.util.ArrayList<>();
        JSArray a = call.getArray("items");
        if (a == null) return out;
        for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            if (o != null && !o.optString("text").trim().isEmpty()) out.add(new ReadAloud.Item(o.optString("id"), o.optString("text"), o.optLong("pause", 0)));
        }
        return out;
    }

    @PluginMethod
    public void voices(PluginCall call) {
        withVoices(() -> {
            if (!voiceListReady) {
                call.reject("This phone has no text-to-speech. Install Speech Services by Google from the Play Store.");
                return;
            }
            JSArray out = new JSArray();
            android.speech.tts.Voice def = voiceList.getDefaultVoice();
            for (android.speech.tts.Voice v : ReadAloud.voices(voiceList)) {
                JSObject o = new JSObject();
                o.put("name", v.getName());
                o.put("locale", v.getLocale().toLanguageTag());
                o.put("country", v.getLocale().getDisplayCountry());
                o.put("quality", v.getQuality());
                o.put("online", v.isNetworkConnectionRequired());
                o.put("isDefault", def != null && def.getName().equals(v.getName()));
                out.put(o);
            }
            JSObject r = new JSObject();
            r.put("voices", out);
            call.resolve(r);
        });
    }

    /** Read a short text once (a flashcard side), in the voice chosen for books. */
    @PluginMethod
    public void say(PluginCall call) {
        String text = call.getString("text", "");
        String voice = call.getString("voice", "");
        float rate = call.getFloat("rate", 1f);
        withVoices(() -> {
            if (!voiceListReady) {
                call.reject("No text-to-speech on this phone.");
                return;
            }
            voiceList.setSpeechRate(rate);
            if (!voice.isEmpty()) for (android.speech.tts.Voice v : ReadAloud.voices(voiceList)) if (v.getName().equals(voice)) voiceList.setVoice(v);
            voiceList.speak(text, android.speech.tts.TextToSpeech.QUEUE_FLUSH, null, "say");
            call.resolve();
        });
    }

    /** Read a book's sentences aloud from the first: [{ id, text }], with its title for the notification. */
    @PluginMethod
    public void readAloud(PluginCall call) {
        ReadAloud.listener = (id, index, total, state) -> {
            JSObject o = new JSObject();
            o.put("id", id);
            o.put("index", index);
            o.put("total", total);
            o.put("state", state);
            notifyListeners("speech", o);
        };
        ReadAloud.start(getContext(), itemsOf(call), call.getString("title", ""), call.getString("voice"), call.getFloat("rate", 0f), call.getBoolean("loop", false));
        call.resolve();
    }

    @PluginMethod
    public void readMore(PluginCall call) {
        ReadAloud.append(itemsOf(call));
        call.resolve();
    }

    /** pause, resume, stop, skip (by: sentences), settings (voice, rate), sleep (minutes). */
    @PluginMethod
    public void readControl(PluginCall call) {
        String a = call.getString("action", "");
        switch (a) {
            case "pause": ReadAloud.pause(); break;
            case "resume": ReadAloud.resume(); break;
            case "stop": ReadAloud.stopAll(); break;
            case "skip": ReadAloud.skip(call.getInt("by", 1)); break;
            case "settings": ReadAloud.settings(call.getString("voice"), call.getFloat("rate", 0f)); break;
            case "sleep": ReadAloud.sleepIn(call.getInt("minutes", 0)); break;
            default: break;
        }
        JSObject r = new JSObject();
        r.put("playing", ReadAloud.isPlaying());
        r.put("id", ReadAloud.currentId());
        r.put("sleepLeft", ReadAloud.sleepLeft());
        call.resolve(r);
    }

    // ---------- Updates: a newer Kea from Kea's own GitHub releases ----------
    @PluginMethod
    public void appInfo(PluginCall call) {
        JSObject r = new JSObject();
        try {
            android.content.pm.PackageInfo p = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            r.put("version", p.versionName);
            r.put("build", Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode);
        } catch (Exception e) {
            r.put("version", "0");
        }
        call.resolve(r);
    }

    /**
     * Download a newer Kea (only from Kea's own GitHub releases), with "update" events for the progress. The file is
     * checked to really be Kea, newer than this one, before it's offered: { path, version }.
     */
    @PluginMethod
    public void downloadUpdate(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.matches("(?i)^https://github\\.com/kadenw213-svg/kea/releases/download/[^\\s]+\\.apk$")) {
            call.reject("Updates only come from Kea's own releases.");
            return;
        }
        new Thread(() -> {
            try {
                File dir = new File(getContext().getCacheDir(), "updates");
                dir.mkdirs();
                File[] old = dir.listFiles();
                if (old != null) for (File f : old) f.delete();
                File out = new File(dir, "Kea-update.apk");
                java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                c.setInstanceFollowRedirects(true);
                c.setConnectTimeout(20000);
                c.setReadTimeout(60000);
                if (c.getResponseCode() != 200) throw new Exception("The download answered " + c.getResponseCode());
                long total = c.getContentLengthLong(), got = 0, last = 0;
                try (InputStream in = c.getInputStream(); OutputStream os = new FileOutputStream(out)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        os.write(buf, 0, n);
                        got += n;
                        if (got - last > 262144) {
                            last = got;
                            JSObject p = new JSObject();
                            p.put("received", got);
                            p.put("total", total);
                            notifyListeners("update", p);
                        }
                    }
                }
                android.content.pm.PackageInfo info = getContext().getPackageManager().getPackageArchiveInfo(out.getAbsolutePath(), 0);
                if (info == null || !getContext().getPackageName().equals(info.packageName)) {
                    out.delete();
                    throw new Exception("The download isn't Kea.");
                }
                JSObject r = new JSObject();
                r.put("path", out.getAbsolutePath());
                r.put("version", info.versionName);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        }).start();
    }

    /** Hand the downloaded update to Android's installer (the student confirms there). { started, needsPermission }. */
    @PluginMethod
    public void installUpdate(PluginCall call) {
        File f = new File(getContext().getCacheDir(), "updates/Kea-update.apk");
        if (!f.exists()) {
            call.reject("The update isn't downloaded yet.");
            return;
        }
        JSObject r = new JSObject();
        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
            // Android asks once whether Kea may install its own updates.
            getActivity().startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName())));
            r.put("started", false);
            r.put("needsPermission", true);
            call.resolve(r);
            return;
        }
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
        Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        getActivity().startActivity(i);
        r.put("started", true);
        call.resolve(r);
    }

    private void onScanned(ActivityResult result) {
        PluginCall call = scanCall;
        scanCall = null;
        if (call == null) return;
        GmsDocumentScanningResult r = GmsDocumentScanningResult.fromActivityResultIntent(result.getData());
        if (result.getResultCode() != Activity.RESULT_OK || r == null || r.getPdf() == null) {
            call.reject("No scan");
            return;
        }
        try {
            // Keep a copy Kea owns (the scanner's own file can go away), shared through Kea's file provider. Pages to add
            // to another scan go to a scratch folder instead (emptied each time), not into Files.
            String name = call.getString("name", "Scan");
            boolean temp = call.getBoolean("temp", false);
            File dir = temp ? new File(getContext().getCacheDir(), "scan-pages") : scansDir();
            dir.mkdirs();
            if (temp) {
                File[] old = dir.listFiles();
                if (old != null) for (File f : old) f.delete();
            }
            File out = freeName(dir, name.replaceAll("[^A-Za-z0-9 ._()#-]", "").trim() + ".pdf");
            try (InputStream in = getContext().getContentResolver().openInputStream(r.getPdf().getUri()); OutputStream os = new FileOutputStream(out)) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", out);
            JSObject ret = new JSObject();
            ret.put("file", uri.toString());
            ret.put("path", out.getAbsolutePath());
            ret.put("pages", r.getPdf().getPageCount());
            ret.put("name", out.getName());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }
}
