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
    }

    // ---------- Settings and sign-in ----------
    @PluginMethod
    public void setup(PluginCall call) {
        String home = call.getString("home", "");
        String user = call.getString("user");
        String pass = call.getString("pass");
        Store.plain(getContext()).edit().putString("home", home).apply();
        if (pass != null && !pass.isEmpty()) Store.secure(getContext()).edit().putString("user", user == null ? "" : user).putString("pass", pass).apply();
        call.resolve();
    }

    @PluginMethod
    public void state(PluginCall call) {
        new Thread(() -> {
            JSObject r = new JSObject();
            r.put("home", Store.home(getContext()));
            r.put("hasLogin", !Store.secure(getContext()).getString("pass", "").isEmpty());
            r.put("signedIn", ClassSite.signedIn(getContext()));
            r.put("dataFolder", Store.plain(getContext()).getString("tree", ""));
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

    /** GET a class-site address with the session (signing in by itself when needed). */
    @PluginMethod
    public void get(PluginCall call) {
        String url = call.getString("url");
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
        if (ClassSite.host(url).equals(ClassSite.host(Store.home(getContext())))) {
            getActivity().startActivity(new Intent(getContext(), SiteActivity.class).putExtra("mode", "open").putExtra("url", url));
        } else {
            getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        }
        call.resolve();
    }

    /** The assignment's own hand-in page with the file given to its upload box. The student presses Submit. */
    @PluginMethod
    public void handIn(PluginCall call) {
        String url = call.getString("url");
        String file = call.getString("file");
        getActivity().startActivity(new Intent(getContext(), SiteActivity.class).putExtra("mode", "handin").putExtra("url", url).putExtra("file", file));
        call.resolve();
    }

    // ---------- Notifications ----------
    @PluginMethod
    public void watch(PluginCall call) {
        Store.plain(getContext()).edit().putString("watch", call.getData().toString()).apply();
        CheckWorker.schedule(getContext());
        call.resolve();
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
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, i, "onFolder");
    }

    @ActivityCallback
    private void onFolder(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("No folder chosen");
            return;
        }
        Uri tree = result.getData().getData();
        getContext().getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Store.plain(getContext()).edit().putString("tree", tree.toString()).apply();
        JSObject r = new JSObject();
        r.put("folder", tree.toString());
        call.resolve(r);
    }

    /** A file inside the chosen folder by its path ("kea-data.json", "Textbooks/BIO1112/x.pdf"). */
    private DocumentFile find(String rel) {
        String tree = Store.plain(getContext()).getString("tree", "");
        if (tree.isEmpty()) return null;
        DocumentFile f = DocumentFile.fromTreeUri(getContext(), Uri.parse(tree));
        for (String part : rel.split("/")) {
            if (f == null || part.isEmpty()) continue;
            f = f.findFile(part);
        }
        return f;
    }

    @PluginMethod
    public void readFile(PluginCall call) {
        String rel = call.getString("path", "kea-data.json");
        new Thread(() -> {
            try {
                DocumentFile f = find(rel);
                if (f == null || !f.exists()) {
                    call.reject("not found");
                    return;
                }
                InputStream in = getContext().getContentResolver().openInputStream(f.getUri());
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                in.close();
                JSObject r = new JSObject();
                r.put("text", out.toString("UTF-8"));
                r.put("modified", f.lastModified());
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        }).start();
    }

    /** Open a file from the folder (a textbook PDF) in the phone's PDF viewer. */
    @PluginMethod
    public void openFile(PluginCall call) {
        DocumentFile f = find(call.getString("path", ""));
        if (f == null || !f.exists()) {
            call.reject("That file isn't in the Kea folder yet.");
            return;
        }
        Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(f.getUri(), "application/pdf").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
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
            // Keep a copy Kea owns (the scanner's own file can go away), shared through Kea's file provider.
            String name = call.getString("name", "Scan");
            File dir = new File(getContext().getCacheDir(), "scans");
            dir.mkdirs();
            File out = new File(dir, name.replaceAll("[^A-Za-z0-9 ._-]", "") + " " + System.currentTimeMillis() + ".pdf");
            try (InputStream in = getContext().getContentResolver().openInputStream(r.getPdf().getUri()); OutputStream os = new FileOutputStream(out)) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", out);
            JSObject ret = new JSObject();
            ret.put("file", uri.toString());
            ret.put("pages", r.getPdf().getPageCount());
            ret.put("name", out.getName());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }
}
