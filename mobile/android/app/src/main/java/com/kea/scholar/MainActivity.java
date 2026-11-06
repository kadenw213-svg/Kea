package com.kea.scholar;

import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;
import java.io.File;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KeaPlugin.class);
        super.onCreate(savedInstanceState);
        if (getBridge() != null) getBridge().setWebViewClient(new OwnFilesOnly(getBridge()));
        // Back closes what's open in Kea (a book, a quiz, a class, a sheet), one step at a time, like any app. Only with
        // nothing left to close does it leave Kea (to the background, so it opens again where it was).
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (getBridge() == null || getBridge().getWebView() == null) {
                    moveTaskToBack(true);
                    return;
                }
                getBridge().getWebView().evaluateJavascript("(window.keaBack && window.keaBack()) ? 'handled' : 'none'", (r) -> {
                    if (r == null || !r.contains("handled")) moveTaskToBack(true);
                });
            }
        });
    }

    /**
     * The app's web view may load files from the phone (Capacitor's /_capacitor_file_/ addresses) only from Kea's own
     * folders: scans, documents, the library, and the scanner's scratch pages. Never Kea's settings, cookies, saved
     * login or anything else in its private storage, whatever a page asks for; other apps' content (/_capacitor_content_/)
     * isn't loaded at all.
     */
    static final class OwnFilesOnly extends BridgeWebViewClient {
        private final Bridge bridge;

        OwnFilesOnly(Bridge bridge) {
            super(bridge);
            this.bridge = bridge;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            String path = request.getUrl() == null ? null : request.getUrl().getPath();
            if (path != null && (path.startsWith(Bridge.CAPACITOR_CONTENT_START) || (path.startsWith(Bridge.CAPACITOR_FILE_START) && !allowed(path)))) return refused();
            return super.shouldInterceptRequest(view, request);
        }

        private boolean allowed(String path) {
            // (The same file Capacitor would open: every marker removed. No "..", and inside one of Kea's own folders.)
            String real = path.replace(Bridge.CAPACITOR_FILE_START, "");
            if (real.contains("..") || real.indexOf(0) >= 0) return false;
            android.content.Context ctx = bridge.getContext();
            File[] roots = {
                new File(ctx.getFilesDir(), "scans"),
                new File(ctx.getFilesDir(), "docs"),
                new File(ctx.getFilesDir(), "library"),
                new File(ctx.getCacheDir(), "scan-pages")
            };
            try {
                String canon = new File(real).getCanonicalPath();
                for (File r : roots) if (canon.startsWith(r.getCanonicalPath() + File.separator)) return true;
            } catch (java.io.IOException ignored) {
            }
            return false;
        }

        private static WebResourceResponse refused() {
            WebResourceResponse r = new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
            r.setStatusCodeAndReasonPhrase(403, "Forbidden");
            return r;
        }
    }
}
