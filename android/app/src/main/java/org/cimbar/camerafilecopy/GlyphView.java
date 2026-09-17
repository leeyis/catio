package org.cimbar.camerafilecopy;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.view.View;

/** Small, theme-aware line icon set shared by navigation and file actions. */
final class GlyphView extends View {
    private final String name;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final int tint;
    GlyphView(Context context, String name, int tint) { super(context); this.name=name; this.tint=tint; setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO); }
    private void line(Canvas c, float... xy) { Path p=new Path(); p.moveTo(xy[0],xy[1]); for(int i=2;i<xy.length;i+=2)p.lineTo(xy[i],xy[i+1]); c.drawPath(p,paint); }
    @Override protected void onDraw(Canvas c) {
        super.onDraw(c); c.save(); c.scale(getWidth()/24f,getHeight()/24f);
        paint.setColor(ReceiverUi.color(getContext(),tint)); paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(1.7f); paint.setStrokeCap(Paint.Cap.ROUND); paint.setStrokeJoin(Paint.Join.ROUND);
        switch(name) {
            case "receive": line(c,8,3,4,3,4,8); line(c,16,3,20,3,20,8); line(c,4,16,4,21,9,21); line(c,20,16,20,21,15,21); line(c,12,7,12,16); line(c,8,12,12,16,16,12); break;
            case "send": line(c,4,10,20,4,15,20,11,13,4,10); line(c,11,13,20,4); break;
            case "files": line(c,3,8,3,5,9,5,12,8,21,8,21,20,3,20,3,8); line(c,3,10,21,10); break;
            case "document": line(c,14,3,5,3,5,21,19,21,19,8,14,3,14,8,19,8); line(c,9,12,15,12); line(c,9,16,15,16); break;
            case "more": paint.setStyle(Paint.Style.FILL); for(int x=5;x<24;x+=7)c.drawCircle(x,12,1.6f,paint); break;
            case "save": line(c,12,3,12,15); line(c,8,11,12,15,16,11); line(c,4,16,4,21,20,21,20,16); break;
            default: c.drawCircle(12,12,8,paint);
        }
        c.restore();
    }
}
