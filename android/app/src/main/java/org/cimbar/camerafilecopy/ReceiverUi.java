package org.cimbar.camerafilecopy;

import android.content.Context;
import android.app.Activity;
import android.content.res.Configuration;
import android.view.View;
import androidx.core.view.WindowCompat;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.core.content.ContextCompat;

final class ReceiverUi {
    static int dp(Context c,float value) { return Math.round(value*c.getResources().getDisplayMetrics().density); }
    static int color(Context c,int res) { return ContextCompat.getColor(c,res); }
    static GradientDrawable surface(Context c,int fill,int radius) {
        GradientDrawable d=new GradientDrawable(); d.setColor(color(c,fill)); d.setCornerRadius(dp(c,radius));
        d.setStroke(dp(c,1),color(c,R.color.border)); return d;
    }
    static TextView text(Context c,CharSequence value,int size,int color,boolean bold) {
        TextView v=new TextView(c); v.setText(value); v.setTextSize(size); v.setTextColor(color(c,color));
        if(bold) v.setTypeface(Typeface.create("sans-serif-medium",Typeface.NORMAL));
        v.setIncludeFontPadding(false); return v;
    }
    static Button button(Context c,CharSequence label,boolean primary) {
        Button b=new Button(c); b.setText(label); b.setAllCaps(false); b.setTextSize(14); b.setMinHeight(dp(c,48));
        b.setStateListAnimator(null); b.setElevation(0);
        b.setMinimumWidth(0); b.setMinWidth(0); b.setPadding(dp(c,14),dp(c,4),dp(c,14),dp(c,4));
        styleButton(b,primary); return b;
    }
    static void styleButton(Button b,boolean primary) {
        Context c=b.getContext();
        b.setTextColor(color(c,primary?R.color.on_accent:R.color.text_primary));
        b.setBackground(new RippleDrawable(ColorStateList.valueOf(0x336366F1),surface(c,primary?R.color.accent:R.color.surface,14),null));
    }
    static void applySystemBars(Activity activity,View root) {
        boolean light=(activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)!=Configuration.UI_MODE_NIGHT_YES;
        WindowCompat.getInsetsController(activity.getWindow(),root).setAppearanceLightStatusBars(light);
        WindowCompat.getInsetsController(activity.getWindow(),root).setAppearanceLightNavigationBars(light);
    }
    static LinearLayout column(Context c) { LinearLayout l=new LinearLayout(c); l.setOrientation(LinearLayout.VERTICAL); return l; }
    static LinearLayout row(Context c) { LinearLayout l=new LinearLayout(c); l.setGravity(Gravity.CENTER_VERTICAL); return l; }
    static LinearLayout.LayoutParams weight() { return new LinearLayout.LayoutParams(0,LinearLayout.LayoutParams.WRAP_CONTENT,1); }
    interface TabListener { void select(int tab); }
    static LinearLayout navigation(Context c,int selected,TabListener listener) {
        LinearLayout outer=column(c); outer.setBackgroundColor(color(c,R.color.surface));
        View line=new View(c); line.setBackgroundColor(color(c,R.color.border)); outer.addView(line,new LinearLayout.LayoutParams(-1,dp(c,1)));
        LinearLayout row=row(c); row.setPadding(dp(c,12),dp(c,4),dp(c,12),dp(c,4)); outer.addView(row);
        int[] labels={R.string.scan,R.string.send,R.string.files}; int[] ids={R.id.tab_receive,R.id.tab_send,R.id.tab_files};
        String[] icons={"receive","send","files"};
        for(int i=0;i<3;i++) {
            final int index=i; boolean active=i==selected;
            LinearLayout tab=column(c); tab.setId(ids[i]); tab.setGravity(Gravity.CENTER); tab.setSelected(active); tab.setFocusable(true);
            tab.setContentDescription(c.getString(labels[i]));
            tab.setBackground(new RippleDrawable(ColorStateList.valueOf(color(c,R.color.accent_soft)),null,null));
            android.widget.FrameLayout pill=new android.widget.FrameLayout(c);
            if(active) pill.setBackground(surface(c,R.color.accent_soft,16));
            GlyphView icon=new GlyphView(c,icons[i],active?R.color.accent:R.color.text_secondary);
            pill.addView(icon,new android.widget.FrameLayout.LayoutParams(dp(c,24),dp(c,24),Gravity.CENTER));
            tab.addView(pill,new LinearLayout.LayoutParams(dp(c,56),dp(c,32)));
            TextView text=text(c,c.getString(labels[i]),11,active?R.color.accent:R.color.text_secondary,active);
            text.setGravity(Gravity.CENTER); text.setPadding(0,dp(c,3),0,0); tab.addView(text);
            tab.setOnClickListener(v->listener.select(index)); row.addView(tab,new LinearLayout.LayoutParams(0,dp(c,62),1));
        }
        return outer;
    }
    static android.widget.FrameLayout iconButton(Context c,String glyph,String label,Runnable action) {
        android.widget.FrameLayout b=new android.widget.FrameLayout(c); b.setContentDescription(label); b.setFocusable(true);
        b.setBackground(new RippleDrawable(ColorStateList.valueOf(color(c,R.color.accent_soft)),surface(c,R.color.sunken,14),null));
        b.addView(new GlyphView(c,glyph,R.color.text_secondary),new android.widget.FrameLayout.LayoutParams(dp(c,21),dp(c,21),Gravity.CENTER));
        b.setOnClickListener(v->action.run()); return b;
    }
    private ReceiverUi() {}
}
