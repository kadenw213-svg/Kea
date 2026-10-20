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
            String tree = Store.plain(getContext()).getString("tree", "");
            r.put("dataFolder", tree.isEmpty() ? Store.plain(getContext()).getString("dataFile", "") : tree);
            r.put("dataFileOnly", tree.isEmpty() && !Store.plain(getContext()).getString("dataFile", "").isEmpty());
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

    /** Share a scan (or any Kea file) through Android's share sheet: email, Messages, Drive, anything. */
    @PluginMethod
    public void share(PluginCall call) {
        Uri uri = Uri.parse(call.getString("file", ""));
        Intent send = new Intent(Intent.ACTION_SEND).setType("application/pdf").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        String title = call.getString("name", "");
        if (!title.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, title);
        getActivity().startActivity(Intent.createChooser(send, "Share"));
        call.resolve();
    }

    /** Save a copy of a scan in the phone's Downloads, under a name the student chose. */
    @PluginMethod
    public void saveCopy(PluginCall call) {
        Uri from = Uri.parse(call.getString("file", ""));
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
        Store.plain(getContext()).edit().putString("tree", tree.toString()).apply();
        JSObject r = new JSObject();
        r.put("folder", tree.toString());
        call.resolve(r);
    }

    /**
     * Just the data file, for drives whose Android app can't share a whole folder (Google Drive, OneDrive): the student
     * picks kea-data.json itself, and the phone reads that file (always its newest copy) from then on.
     */
    @PluginMethod
    public void pickDataFile(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, i, "onDataFile");
    }

    @ActivityCallback
    private void onDataFile(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("No file chosen");
            return;
        }
        Uri file = result.getData().getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(file, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException e) {
            // (Some drives grant only this session: the phone keeps its last copy until the file is chosen again.)
        }
        Store.plain(getContext()).edit().putString("dataFile", file.toString()).apply();
        JSObject r = new JSObject();
        r.put("file", file.toString());
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
                Uri uri = f != null && f.exists() ? f.getUri() : null;
                long modified = uri != null ? f.lastModified() : 0;
                // The data file chosen on its own (a drive that can't share folders).
                String one = Store.plain(getContext()).getString("dataFile", "");
                if (uri == null && "kea-data.json".equals(rel) && !one.isEmpty()) uri = Uri.parse(one);
                if (uri == null) {
                    call.reject(Store.plain(getContext()).getString("tree", "").isEmpty() && one.isEmpty() ? "No Kea folder or file chosen yet" : "not found");
                    return;
                }
                InputStream in = getContext().getContentResolver().openInputStream(uri);
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                in.close();
                JSObject r = new JSObject();
                r.put("text", out.toString("UTF-8"));
                r.put("modified", modified);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        }).start();
    }

    /** Write the phone's own file in the folder (phone.json: what it checked off and read), for Kea on the PC. */
    @PluginMethod
    public void writeFile(PluginCall call) {
        String name = call.getString("path", "phone.json");
        String text = call.getString("text", "");
        new Thread(() -> {
            try {
                String tree = Store.plain(getContext()).getString("tree", "");
                if (tree.isEmpty()) {
                    call.reject("No folder chosen");
                    return;
                }
                DocumentFile dir = DocumentFile.fromTreeUri(getContext(), Uri.parse(tree));
                DocumentFile f = dir == null ? null : dir.findFile(name);
                if (f == null && dir != null) f = dir.createFile("application/json", name);
                if (f == null) {
                    call.reject("Couldn't write to the Kea folder");
                    return;
                }
                try (OutputStream os = getContext().getContentResolver().openOutputStream(f.getUri(), "wt")) {
                    os.write(text.getBytes("UTF-8"));
                }
                call.resolve();
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
