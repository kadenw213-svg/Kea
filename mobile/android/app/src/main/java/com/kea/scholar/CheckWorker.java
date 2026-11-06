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

    /** The student's notification choices (Settings → Notifications), saved by KeaPlugin.setNotify. */
    static JSONObject prefs(Context ctx) {
        try {
            return new JSONObject(Store.plain(ctx).getString("notify", "{}"));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    /** Checks every `every` minutes (15 at the least, Android's limit; 0: only when Kea is opened or refreshed). */
    static void schedule(Context ctx) {
        int every = prefs(ctx).optInt("every", 15);
        SharedPreferences sp = Store.plain(ctx);
        WorkManager wm = WorkManager.getInstance(ctx);
        if (every <= 0) {
            wm.cancelUniqueWork("kea-check");
            sp.edit().putInt("everyScheduled", 0).apply();
            return;
        }
        every = Math.max(15, every);
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(CheckWorker.class, every, TimeUnit.MINUTES)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build();
        // (A new interval replaces the old schedule; the same one keeps it, so it isn't pushed back on every start.)
        boolean changed = sp.getInt("everyScheduled", -1) != every;
        wm.enqueueUniquePeriodicWork("kea-check", changed ? ExistingPeriodicWorkPolicy.REPLACE : ExistingPeriodicWorkPolicy.KEEP, req);
        sp.edit().putInt("everyScheduled", every).apply();
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

        if (ClassSite.canvas(ctx)) {
            checkCanvas(ctx, base, courses, seen, fresh);
            return finish(ctx, sp, seen, fresh, seeded, notify);
        }
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

        return finish(ctx, sp, seen, fresh, seeded, notify);
    }

    /**
     * A Canvas school: each class's announcements and graded work (with the instructor's comments), and unread messages
     * from Canvas's Inbox, from Canvas's data API.
     */
    static void checkCanvas(Context ctx, Uri base, JSONArray courses, Set<String> seen, List<JSONObject> fresh) throws Exception {
        for (int i = 0; i < courses.length(); i++) {
            JSONObject c = courses.getJSONObject(i);
            String code = c.optString("code"), ou = c.optString("ou");
            if (ou.isEmpty()) continue;
            ClassSite.Answer a = ClassSite.get(ctx, base.buildUpon().encodedPath("/api/v1/courses/" + ou + "/discussion_topics").encodedQuery("only_announcements=true&per_page=30").build().toString());
            if (a.status == 200 && a.body.trim().startsWith("[")) {
                JSONArray news = new JSONArray(a.body);
                for (int k = 0; k < news.length(); k++) {
                    JSONObject n = news.getJSONObject(k);
                    String key = "news:" + code + ":" + n.optString("id") + ":" + n.optString("posted_at");
                    if (seen.add(key)) {
                        String text = android.text.Html.fromHtml(n.optString("message", ""), android.text.Html.FROM_HTML_MODE_COMPACT).toString().trim();
                        fresh.add(item("announcement", code, n.optString("title"), text, n.optString("posted_at", ""), n.optString("html_url", "")));
                    }
                }
            }
            ClassSite.Answer g = ClassSite.get(ctx, base.buildUpon().encodedPath("/api/v1/courses/" + ou + "/students/submissions").encodedQuery("per_page=100&include[]=assignment&include[]=submission_comments").build().toString());
            if (g.status == 200 && g.body.trim().startsWith("[")) {
                JSONArray subs = new JSONArray(g.body);
                for (int k = 0; k < subs.length(); k++) {
                    JSONObject s = subs.getJSONObject(k);
                    // Only a real score or grade (Canvas gives one only once the grade is posted to the student).
                    if (s.isNull("score") && s.optString("grade", "").trim().isEmpty() && !s.optBoolean("excused")) continue;
                    JSONObject asg = s.optJSONObject("assignment");
                    String name = asg == null ? "an assignment" : asg.optString("name");
                    String comment = "";
                    JSONArray cs = s.optJSONArray("submission_comments");
                    if (cs != null && cs.length() > 0) comment = cs.getJSONObject(cs.length() - 1).optString("comment", "");
                    String score = s.optBoolean("excused") ? "Excused"
                        : !s.isNull("score") && asg != null && !asg.isNull("points_possible") ? trim(s.optDouble("score")) + " / " + trim(asg.optDouble("points_possible"))
                        : s.optString("grade");
                    String key = "grade:" + code + ":" + s.optString("assignment_id") + ":" + score + ":" + comment.hashCode();
                    if (seen.add(key)) {
                        fresh.add(item("grade", code, "New grade: " + name, score + (comment.isEmpty() ? "" : "\n\n" + comment), "",
                            base.buildUpon().encodedPath("/courses/" + ou + "/grades").clearQuery().build().toString()));
                    }
                }
            }
        }
        // Unread messages in Canvas's Inbox.
        ClassSite.Answer m = ClassSite.get(ctx, base.buildUpon().encodedPath("/api/v1/conversations").encodedQuery("scope=unread&per_page=20").build().toString());
        if (m.status == 200 && m.body.trim().startsWith("[")) {
            JSONArray list = new JSONArray(m.body);
            for (int k = 0; k < list.length(); k++) {
                JSONObject cv = list.getJSONObject(k);
                String key = "msg:" + cv.optString("id") + ":" + cv.optString("last_message_at");
                if (!seen.add(key)) continue;
                String context = cv.optString("context_name", "");
                String course = "";
                for (int i = 0; i < courses.length(); i++) {
                    String code = courses.getJSONObject(i).optString("code");
                    String spaced = code.replaceAll("([A-Za-z]+)(\\d+)", "$1 $2");
                    if (!code.isEmpty() && (context.contains(code) || context.contains(spaced))) course = code;
                }
                // The whole message and its sender (the list only has the start of the last message).
                String body = cv.optString("last_message", "");
                String from = "";
                try {
                    ClassSite.Answer full = ClassSite.get(ctx, base.buildUpon().encodedPath("/api/v1/conversations/" + cv.optString("id")).clearQuery().build().toString());
                    if (full.status == 200 && full.body.trim().startsWith("{")) {
                        JSONObject conv = new JSONObject(full.body);
                        JSONArray msgs = conv.optJSONArray("messages");
                        JSONArray people = conv.optJSONArray("participants");
                        if (msgs != null && msgs.length() > 0) {
                            JSONObject last = msgs.getJSONObject(0);
                            if (!last.optString("body", "").trim().isEmpty()) body = last.optString("body").trim();
                            if (people != null) for (int p = 0; p < people.length(); p++) {
                                JSONObject who = people.getJSONObject(p);
                                if (who.optString("id").equals(last.optString("author_id"))) from = who.optString("name", "");
                            }
                        }
                    }
                } catch (Exception ignored) {
                }
                JSONObject it = item("news", course, cv.optString("subject", "Message"), body, cv.optString("last_message_at", ""),
                    base.buildUpon().encodedPath("/conversations/" + cv.optString("id")).clearQuery().build().toString());
                it.put("from", from);
                it.put("conv", cv.optString("id"));
                fresh.add(it);
            }
        }
    }

    /** Remember what was seen (newest last, capped), keep the new items for the app's Inbox, and notify them. */
    static List<JSONObject> finish(Context ctx, SharedPreferences sp, Set<String> seen, List<JSONObject> fresh, boolean seeded, boolean notify) throws Exception {
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
        if (seeded && notify) {
            int n = 0;
            for (JSONObject f : fresh) {
                if (n >= 6) break;
                if (!wanted(ctx, f)) continue;
                post(ctx, f);
                n++;
            }
        }
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

    /** What kind of notification an item is: messages, announcements or grades (each can be turned off). */
    static String kindOf(JSONObject f) {
        String k = f.optString("kind");
        return k.equals("grade") ? "grades" : k.equals("announcement") ? "announcements" : "messages";
    }

    /** Whether the student wants this one notified: its kind and its class turned on (it's in the Inbox either way). */
    static boolean wanted(Context ctx, JSONObject f) {
        JSONObject p = prefs(ctx);
        if (p.has(kindOf(f)) && !p.optBoolean(kindOf(f), true)) return false;
        JSONObject off = p.optJSONObject("classesOff");
        return off == null || f.optString("course").isEmpty() || !off.optBoolean(f.optString("course"), false);
    }

    /** Inside the quiet hours ("22:00" to "07:00"): notified without a sound or buzz. */
    static boolean quiet(Context ctx) {
        JSONObject p = prefs(ctx);
        String from = p.optString("quietFrom", ""), to = p.optString("quietTo", "");
        if (!from.matches("\\d{1,2}:\\d{2}") || !to.matches("\\d{1,2}:\\d{2}")) return false;
        java.util.Calendar c = java.util.Calendar.getInstance();
        int now = c.get(java.util.Calendar.HOUR_OF_DAY) * 60 + c.get(java.util.Calendar.MINUTE);
        int a = Integer.parseInt(from.split(":")[0]) * 60 + Integer.parseInt(from.split(":")[1]);
        int b = Integer.parseInt(to.split(":")[0]) * 60 + Integer.parseInt(to.split(":")[1]);
        return a <= b ? now >= a && now < b : now >= a || now < b;
    }

    static String channel(Context ctx, String kind) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        String id = kind.equals("grades") ? "kea_grades" : kind.equals("announcements") ? "kea_announcements" : "kea_messages";
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(id) == null) {
            String name = kind.equals("grades") ? "Grades" : kind.equals("announcements") ? "Announcements" : "Messages";
            nm.createNotificationChannel(new NotificationChannel(id, name, kind.equals("messages") ? NotificationManager.IMPORTANCE_HIGH : NotificationManager.IMPORTANCE_DEFAULT));
        }
        return id;
    }

    static void post(Context ctx, JSONObject f) {
        String kind = kindOf(f);
        Intent open = new Intent(ctx, MainActivity.class).putExtra("open", "inbox").addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int nid = f.optString("id").hashCode();
        PendingIntent pi = PendingIntent.getActivity(ctx, nid, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String course = f.optString("course"), from = f.optString("from"), title = f.optString("title"), body = f.optString("body");
        // A message: who sent it and the class, then the whole message (its subject first). Others: the class and title.
        boolean msg = kind.equals("messages");
        String head = msg && !from.isEmpty() ? from + (course.isEmpty() ? "" : " · " + course) : (course.isEmpty() ? "" : course + ": ") + title;
        String text = msg && !from.isEmpty() ? (title.isEmpty() || body.startsWith(title) ? body : title + "\n\n" + body) : body;
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, channel(ctx, kind))
            .setSmallIcon(R.drawable.ic_stat_kea)
            .setColor(0xFF8AB4F8)
            .setContentTitle(head)
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setSilent(quiet(ctx))
            .setContentIntent(pi);
        if (msg) {
            if (!f.optString("conv").isEmpty() && Build.VERSION.SDK_INT >= 24) {
                // Reply right here: the answer goes to the conversation on the class site (ReplyReceiver).
                androidx.core.app.RemoteInput in = new androidx.core.app.RemoteInput.Builder(ReplyReceiver.KEY).setLabel("Reply to " + (from.isEmpty() ? "the message" : from)).build();
                Intent r = new Intent(ctx, ReplyReceiver.class).putExtra("conv", f.optString("conv")).putExtra("url", f.optString("url")).putExtra("nid", nid).putExtra("head", head);
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                PendingIntent rp = PendingIntent.getBroadcast(ctx, nid, r, flags);
                b.addAction(new NotificationCompat.Action.Builder(R.drawable.ic_stat_kea, "Reply", rp).addRemoteInput(in).setAllowGeneratedReplies(false).build());
            } else if (!f.optString("url").isEmpty()) {
                // (No way to send it from here: Reply opens the message on the class site, in Kea.)
                Intent site = new Intent(ctx, SiteActivity.class).putExtra("mode", "open").putExtra("url", f.optString("url")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                b.addAction(R.drawable.ic_stat_kea, "Reply", PendingIntent.getActivity(ctx, nid + 1, site, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
            }
        }
        try {
            NotificationManagerCompat.from(ctx).notify(f.optString("id").hashCode(), b.build());
        } catch (SecurityException ignored) {
            // Notifications not allowed yet: the item is still in the Inbox.
        }
    }
}
