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

    private String themeScript;

    /**
     * Kea's colours on the page (the same script as the desktop's class-site window, built into the app as
     * assets/site-theme.js): dark themes darken it to the phone's colours, and the site's brand colour becomes the accent.
     * Run as the page starts (so it doesn't flash white) and again once it's loaded.
     */
    private void theme(WebView view) {
        String settings = Store.plain(this).getString("siteTheme", "");
        if (settings.isEmpty()) return;
        if (themeScript == null) {
            try (java.io.InputStream in = getAssets().open("site-theme.js")) {
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[16384];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                themeScript = out.toString("UTF-8");
            } catch (Exception e) {
                themeScript = "";
            }
        }
        if (themeScript.isEmpty()) return;
        view.evaluateJavascript(themeScript + "\n;window.__keaSiteTheme && window.__keaSiteTheme.setDark(" + settings + ");", null);
    }

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
        // A file on the class site (slides, a Word handout, a spreadsheet, a PDF): downloaded with the session and
        // opened in Kea's own viewer, and kept under Files. (Without this, tapping a file here did nothing.)
        web.setDownloadListener((link, agent, disposition, mime, length) -> download(link, agent, disposition, mime));

        web.setWebViewClient(new WebViewClient() {
            int tries = 0;

            @Override
            public void onPageStarted(WebView view, String u, android.graphics.Bitmap icon) {
                theme(view);
            }

            @Override
            public void onPageFinished(WebView view, String u) {
                theme(view);
                currentUrl = u;
                CookieManager.getInstance().flush();
                view.evaluateJavascript(ClassSite.CAPTURE_SCRIPT, null);
                if (ClassSite.onSite(SiteActivity.this, u)) {
                    if ("signin".equals(mode)) {
                        notifySignIn(true);
                        finish();
                        return;
                    }
                    if ("handin".equals(mode) && !fileGiven && !uploadPressed) {
                        // Open the page's upload box so the scanned file can go straight in (once: on Canvas the
                        // button that opens the hand-in form is pressed a single time).
                        uploadPressed = true;
                        view.postDelayed(() -> view.evaluateJavascript(ClassSite.canvas(SiteActivity.this) ? PRESS_UPLOAD_CANVAS : PRESS_UPLOAD, null), 1200);
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

    private boolean uploadPressed = false;

    /**
     * On a Canvas assignment: presses the button that opens its hand-in form ("Start Assignment" or "New Attempt", never
     * a button inside a form: the form's own "Submit Assignment" is the student's to press), then its file box.
     */
    static final String PRESS_UPLOAD_CANVAS = "(function(){var own='a.submit_assignment_link,[data-testid=\"start-assignment-button\"],[data-testid=\"new-attempt-button\"]';"
        + "var b=[].filter.call(document.querySelectorAll(own+',button,a'),function(el){return el.offsetParent!==null&&!el.closest('form')&&el.type!=='submit'&&(el.matches(own)||/^(start assignment|new attempt|try again)$/i.test((el.innerText||'').trim()));})[0];"
        + "if(b)b.click();setTimeout(function(){var f=document.querySelector('input[type=file]');if(f)f.click();},1800);})()";

    /** Presses "Add a File" / "Upload" on a D2L hand-in page (looking inside Brightspace's components too). */
    static final String PRESS_UPLOAD = "(function(){var all=[];function walk(r){[].forEach.call(r.querySelectorAll('*'),function(el){all.push(el);if(el.shadowRoot)walk(el.shadowRoot);});}walk(document);"
        + "var b=all.filter(function(el){return /^(BUTTON|D2L-BUTTON|D2L-BUTTON-SUBTLE|A)$/.test(el.tagName)&&/add a file|upload|choose file|browse/i.test((el.innerText||el.getAttribute('text')||el.getAttribute('aria-label')||'').trim());})[0];"
        + "if(b)b.click();})()";

    /** Download a class-site file with this session's cookies, then open it in Kea (MainActivity). */
    private void download(String url, String agent, String disposition, String mime) {
        android.widget.Toast.makeText(this, "Opening the file in Kea…", android.widget.Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            try {
                java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                String cookies = CookieManager.getInstance().getCookie(url);
                if (cookies != null) c.setRequestProperty("Cookie", cookies);
                if (agent != null) c.setRequestProperty("User-Agent", agent);
                c.setInstanceFollowRedirects(true);
                String cd = c.getHeaderField("Content-Disposition");
                String type = c.getContentType() != null ? c.getContentType() : mime;
                String name = android.webkit.URLUtil.guessFileName(url, cd != null ? cd : disposition, type);
                java.io.File dir = KeaPlugin.docsDir(this);
                dir.mkdirs();
                java.io.File out = KeaPlugin.freeName(dir, name);
                try (java.io.InputStream in = c.getInputStream(); java.io.OutputStream os = new java.io.FileOutputStream(out)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                }
                final String t = type;
                runOnUiThread(() -> startActivity(new Intent(this, MainActivity.class).putExtra("keaFile", out.getAbsolutePath()).putExtra("keaType", t == null ? "" : t).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)));
            } catch (Exception e) {
                runOnUiThread(() -> android.widget.Toast.makeText(this, "Kea couldn't download that file: " + e.getMessage(), android.widget.Toast.LENGTH_LONG).show());
            }
        }).start();
    }

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
