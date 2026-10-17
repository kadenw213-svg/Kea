package com.kea.scholar;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import androidx.work.Constraints;
import androidx.work.NetworkType;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;

/**
 * Every 15 minutes or so (Android decides the exact time), Kea asks the class site for each class's announcements and
 * grades, plus the student's messages and replies when the class site offers them, and notifies what's new. No
 * Claude, no PC: the phone talks to the class site directly. New items also go to the app's Inbox.
 */
public class CheckWorker extends Worker {
    static final String CHANNEL = "kea_classes";

    public CheckWorker(@NonNull Context ctx, @NonNull WorkerParameters params) {
        super(ctx, params);
    }

    static void schedule(Context ctx) {
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(CheckWorker.class, 15, TimeUnit.MINUTES)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build();
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("kea-check", ExistingPeriodicWorkPolicy.KEEP, req);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            check(getApplicationContext(), true);
            return Result.success();
        } catch (Exception e) {
            return Result.retry();
        }
    }

    /** One check. Returns the new items (also notified when `notify`). Call off the main thread. */
    static List<JSONObject> check(Context ctx, boolean notify) throws Exception {
        SharedPreferences sp = Store.plain(ctx);
        String home = Store.home(ctx);
        JSONObject watch = new JSONObject(sp.getString("watch", "{}"));
        JSONArray courses = watch.optJSONArray("courses");
        List<JSONObject> fresh = new ArrayList<>();
        if (home.isEmpty() || courses == null) return fresh;
        String le = watch.optString("le", "1.74");
        Set<String> seen = new HashSet<>();
        JSONArray seenArr = new JSONArray(sp.getString("seen", "[]"));
        for (int i = 0; i < seenArr.length(); i++) seen.add(seenArr.getString(i));
        boolean seeded = sp.getBoolean("seeded", false);
        Uri base = Uri.parse(home);

        for (int i = 0; i < courses.length(); i++) {
            JSONObject c = courses.getJSONObject(i);
            String code = c.optString("code"), ou = c.optString("ou");
            if (ou.isEmpty()) continue;
            // Announcements.
            ClassSite.Answer a = ClassSite.get(ctx, base.buildUpon().encodedPath("/d2l/api/le/" + le + "/" + ou + "/news/").clearQuery().build().toString());
            if (a.status == 200 && a.body.trim().startsWith("[")) {
                JSONArray news = new JSONArray(a.body);
                for (int k = 0; k < news.length(); k++) {
                    JSONObject n = news.getJSONObject(k);
                    if (n.optBoolean("IsHidden")) continue;
                    String key = "news:" + code + ":" + n.optString("Id") + ":" + n.optString("LastModifiedDate");
                    if (seen.add(key)) {
                        JSONObject body = n.optJSONObject("Body");
                        String text = body == null ? "" : body.optString("Text", "");
                        fresh.add(item("announcement", code, n.optString("Title"), text, n.optString("StartDate"),
                            base.buildUpon().encodedPath("/d2l/le/news/" + ou + "/" + n.optString("Id") + "/view").encodedQuery("ou=" + ou).build().toString()));
                    }
                }
            }
            // Grades (with the instructor's comment).
            ClassSite.Answer g = ClassSite.get(ctx, base.buildUpon().encodedPath("/d2l/api/le/" + le + "/" + ou + "/grades/values/myGradeValues/").clearQuery().build().toString());
            if (g.status == 200 && g.body.trim().startsWith("[")) {
                JSONArray grades = new JSONArray(g.body);
                for (int k = 0; k < grades.length(); k++) {
                    JSONObject v = grades.getJSONObject(k);
                    if (v.isNull("PointsNumerator") && v.optString("DisplayedGrade", "").trim().isEmpty()) continue;
                    JSONObject com = v.optJSONObject("Comments");
                    String comment = com == null ? "" : com.optString("Text", "");
                    String score = v.isNull("PointsDenominator") ? v.optString("DisplayedGrade") : trim(v.optDouble("PointsNumerator")) + " / " + trim(v.optDouble("PointsDenominator"));
                    String key = "grade:" + code + ":" + v.optString("GradeObjectIdentifier") + ":" + score + ":" + comment.hashCode();
                    if (seen.add(key)) {
                        fresh.add(item("grade", code, "New grade: " + v.optString("GradeObjectName"), score + (comment.isEmpty() ? "" : "\n\n" + comment), "",
                            base.buildUpon().encodedPath("/d2l/lms/grades/my_grades/main.d2l").encodedQuery("ou=" + ou).build().toString()));
                    }
                }
            }
        }

        // Messages and updates (replies to your posts, feedback): the class site's own alert menus.
        java.util.regex.Matcher hm = java.util.regex.Pattern.compile("/d2l/home/(\\d+)").matcher(home);
        if (hm.find()) {
            String homeOu = hm.group(1);
            int[] cats = {1, 2, 0};
            for (int cat : cats) {
                try {
                    ClassSite.Answer al = ClassSite.get(ctx, base.buildUpon().encodedPath("/d2l/MiniBar/" + homeOu + "/ActivityFeed/GetAlertsDaylight")
                        .encodedQuery("Category=" + cat + "&_d2l_prc%24headingLevel=2&_d2l_prc%24scope=&_d2l_prc%24hasActiveForm=false&isXhr=true&requestId=1").build().toString());
                    if (al.status != 200) continue;
                    String html = al.body;
                    try {
                        JSONObject j = new JSONObject(html.replaceFirst("^while\\(1\\);", ""));
                        JSONObject payload = j.optJSONObject("Payload");
                        html = payload != null ? payload.optString("Html", html) : j.optString("Html", html);
                    } catch (Exception ignored) {
                    }
                    java.util.regex.Matcher li = java.util.regex.Pattern.compile("<li[^>]*>([\\s\\S]*?)</li>", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(html);
                    while (li.find()) {
                        String inner = li.group(1);
                        String text = android.text.Html.fromHtml(inner, android.text.Html.FROM_HTML_MODE_COMPACT).toString().replaceAll("[ \\t]+", " ").trim();
                        if (text.length() < 4 || text.matches("(?is).*no (new )?(alerts|messages|updates).*")) continue;
                        String key = "alert:" + cat + ":" + text.hashCode();
                        if (!seen.add(key)) continue;
                        java.util.regex.Matcher href = java.util.regex.Pattern.compile("href=\"([^\"]+)\"").matcher(inner);
                        String url = "";
                        if (href.find() && !href.group(1).startsWith("javascript")) {
                            try {
                                url = new java.net.URI(home).resolve(href.group(1).replace("&amp;", "&")).toString();
                            } catch (Exception ignored) {
                            }
                        }
                        String course = "";
                        for (int i = 0; i < courses.length(); i++) if (text.contains(courses.getJSONObject(i).optString("code"))) course = courses.getJSONObject(i).optString("code");
                        String[] lines = text.split("\n", 2);
                        fresh.add(item("news", course, lines[0], lines.length > 1 ? lines[1].trim() : lines[0], "", url));
                    }
                } catch (Exception ignored) {
                }
            }
        }

        // Remember what was seen (newest last, capped), and keep the new items for the app's Inbox.
        JSONArray keep = new JSONArray();
        List<String> all = new ArrayList<>(seen);
        for (int i = Math.max(0, all.size() - 3000); i < all.size(); i++) keep.put(all.get(i));
        SharedPreferences.Editor e = sp.edit().putString("seen", keep.toString()).putBoolean("seeded", true);
        if (seeded && !fresh.isEmpty()) {
            JSONArray inbox = new JSONArray(sp.getString("phoneInbox", "[]"));
            JSONArray merged = new JSONArray();
            for (JSONObject f : fresh) merged.put(f);
            for (int i = 0; i < inbox.length() && merged.length() < 300; i++) merged.put(inbox.get(i));
            e.putString("phoneInbox", merged.toString());
        }
        e.apply();
        if (seeded && notify) for (JSONObject f : fresh.subList(0, Math.min(6, fresh.size()))) post(ctx, f);
        return seeded ? fresh : new ArrayList<>();
    }

    static String trim(double d) {
        return d == Math.floor(d) ? String.valueOf((long) d) : String.valueOf(Math.round(d * 100) / 100.0);
    }

    static JSONObject item(String kind, String course, String title, String body, String at, String url) throws Exception {
        JSONObject o = new JSONObject();
        o.put("id", kind + ":" + course + ":" + title.hashCode() + ":" + body.hashCode());
        o.put("kind", kind);
        o.put("course", course);
        o.put("title", title);
        o.put("body", body);
        o.put("at", at.isEmpty() ? new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US).format(new java.util.Date()) : at);
        o.put("url", url);
        o.put("read", false);
        return o;
    }

    static void post(Context ctx, JSONObject f) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Your classes", NotificationManager.IMPORTANCE_DEFAULT));
        }
        Intent open = new Intent(ctx, MainActivity.class).putExtra("open", "inbox").addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, f.optString("id").hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(f.optString("course") + ": " + f.optString("title"))
            .setContentText(f.optString("body"))
            .setStyle(new NotificationCompat.BigTextStyle().bigText(f.optString("body")))
            .setAutoCancel(true)
            .setContentIntent(pi);
        try {
            NotificationManagerCompat.from(ctx).notify(f.optString("id").hashCode(), b.build());
        } catch (SecurityException ignored) {
            // Notifications not allowed yet: the item is still in the Inbox.
        }
    }
}
