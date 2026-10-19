package com.kea.scholar;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Kea's visible class-site window on the phone, already signed in. Three uses:
 *  - open: show a class page (an assignment, a quiz, the grades page);
 *  - signin: when Kea couldn't sign in by itself, the student finishes signing in here (and the login is saved);
 *  - handin: the assignment's own hand-in page, with the scanned file handed to its upload box. The student checks it
 *    and presses Submit; Kea never submits.
 */
public class SiteActivity extends Activity {
    static ClassSite.Done signInListener;

    private WebView web;
    private ValueCallback<Uri[]> pending;
    private Uri handInFile;
    private boolean fileGiven = false;
    private String mode;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        mode = getIntent().getStringExtra("mode");
        String url = getIntent().getStringExtra("url");
        String file = getIntent().getStringExtra("file");
        if (file != null) handInFile = Uri.parse(file);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#131314"));
        root.setFitsSystemWindows(true);

        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(14), dp(8), dp(6), dp(8));
        TextView title = new TextView(this);
        title.setTextColor(Color.parseColor("#e3e4e6"));
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextSize(15);
        title.setText("handin".equals(mode) ? "Hand in: check it, then press Submit" : "signin".equals(mode) ? "Finish signing in to your class site" : "Class site");
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Button close = new Button(this);
        close.setText("Done");
        close.setAllCaps(false);
        close.setOnClickListener((v) -> finish());
        bar.addView(close);
        root.addView(bar);

        web = new WebView(this);
        root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        // Lets Kea save the login the student types here (so next time it signs in by itself).
        web.addJavascriptInterface(new LoginBridge(), "KeaLogin");

        web.setWebViewClient(new WebViewClient() {
            int tries = 0;

            @Override
            public void onPageFinished(WebView view, String u) {
                currentUrl = u;
                CookieManager.getInstance().flush();
                view.evaluateJavascript(ClassSite.CAPTURE_SCRIPT, null);
                if (ClassSite.onSite(SiteActivity.this, u)) {
                    if ("signin".equals(mode)) {
                        notifySignIn(true);
                        finish();
                        return;
                    }
                    if ("handin".equals(mode) && !fileGiven) {
                        // Open the page's upload box so the scanned file can go straight in.
                        view.postDelayed(() -> view.evaluateJavascript(PRESS_UPLOAD, null), 1200);
                    }
                } else if (tries++ < 3 && ClassSite.mayFill(SiteActivity.this, u)) {
                    // The sign-in page the login was saved on: try it first.
                    String user = Store.secure(SiteActivity.this).getString("user", "");
                    String pass = Store.secure(SiteActivity.this).getString("pass", "");
                    if (!pass.isEmpty()) view.postDelayed(() -> view.evaluateJavascript(ClassSite.fillScript(user, pass), null), 900);
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                // The first upload box gets the scanned file; any later one lets the student choose.
                if (handInFile != null && !fileGiven) {
                    fileGiven = true;
                    callback.onReceiveValue(new Uri[]{handInFile});
                    return true;
                }
                pending = callback;
                try {
                    startActivityForResult(params.createIntent(), 7);
                } catch (Exception e) {
                    pending = null;
                    callback.onReceiveValue(null);
                }
                return true;
            }
        });
        web.loadUrl(url != null ? url : Store.home(this));
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == 7 && pending != null) {
            pending.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
            pending = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if ("signin".equals(mode) && signInListener != null) {
            // Closed without reaching the class site: check the session off the main thread.
            final android.content.Context app = getApplicationContext();
            new Thread(() -> {
                boolean ok = ClassSite.signedIn(app);
                ClassSite.MAIN.post(() -> notifySignIn(ok));
            }).start();
        }
        super.onDestroy();
    }

    private void notifySignIn(boolean ok) {
        ClassSite.Done l = signInListener;
        signInListener = null;
        if (l != null) l.run(ok);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    /** Presses "Add a File" / "Upload" on a D2L hand-in page (looking inside Brightspace's components too). */
    static final String PRESS_UPLOAD = "(function(){var all=[];function walk(r){[].forEach.call(r.querySelectorAll('*'),function(el){all.push(el);if(el.shadowRoot)walk(el.shadowRoot);});}walk(document);"
        + "var b=all.filter(function(el){return /^(BUTTON|D2L-BUTTON|D2L-BUTTON-SUBTLE|A)$/.test(el.tagName)&&/add a file|upload|choose file|browse/i.test((el.innerText||el.getAttribute('text')||el.getAttribute('aria-label')||'').trim());})[0];"
        + "if(b)b.click();})()";

    /** The page actually showing (from the WebView, not from anything a page says about itself). */
    volatile String currentUrl = "";

    final class LoginBridge {
        @JavascriptInterface
        public void save(String user, String pass, String url) {
            // Only from a sign-in page over https (not the class site itself), and only a real password. The page's
            // own claim about where it is isn't trusted: the address shown in the WebView is what's saved with it.
            String at = currentUrl;
            if (pass == null || pass.isEmpty() || at == null || !at.toLowerCase().startsWith("https://") || ClassSite.onSite(SiteActivity.this, at)) return;
            android.content.SharedPreferences.Editor e = Store.secure(SiteActivity.this).edit().putString("pass", pass).putString("loginHost", ClassSite.host(at).toLowerCase());
            if (user != null && !user.isEmpty()) e.putString("user", user);
            e.apply();
        }
    }
}
