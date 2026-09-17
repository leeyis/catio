package org.cimbar.camerafilecopy;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.view.View;

final class ScanOverlay extends View {
    private final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF guide=new RectF();
    private final Path brackets=new Path(), outline=new Path();
    private static final int[] ORDER={0,1,3,2};
    private ScanSnapshot snapshot;
    private boolean good, paused;
    ScanOverlay(Context context) { super(context); setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO); }
    void update(ScanSnapshot value, boolean receiving, boolean isPaused) { snapshot=value; good=receiving; paused=isPaused; invalidate(); }
    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float size=Math.min(getWidth(),getHeight())*.8f;
        guide.set((getWidth()-size)/2,(getHeight()-size)/2,(getWidth()+size)/2,(getHeight()+size)/2);
        paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(ReceiverUi.dp(getContext(),2));
        paint.setColor(paused?0xFF94A3B8:good?0xFF4ADE80:0xFFE2E8F0);
        float length=ReceiverUi.dp(getContext(),24), r=ReceiverUi.dp(getContext(),12);
        brackets.reset();
        brackets.moveTo(guide.left,guide.top+length); brackets.lineTo(guide.left,guide.top+r); brackets.quadTo(guide.left,guide.top,guide.left+r,guide.top); brackets.lineTo(guide.left+length,guide.top);
        brackets.moveTo(guide.right-length,guide.top); brackets.lineTo(guide.right-r,guide.top); brackets.quadTo(guide.right,guide.top,guide.right,guide.top+r); brackets.lineTo(guide.right,guide.top+length);
        brackets.moveTo(guide.right,guide.bottom-length); brackets.lineTo(guide.right,guide.bottom-r); brackets.quadTo(guide.right,guide.bottom,guide.right-r,guide.bottom); brackets.lineTo(guide.right-length,guide.bottom);
        brackets.moveTo(guide.left+length,guide.bottom); brackets.lineTo(guide.left+r,guide.bottom); brackets.quadTo(guide.left,guide.bottom,guide.left,guide.bottom-r); brackets.lineTo(guide.left,guide.bottom-length);
        canvas.drawPath(brackets,paint);
        if(snapshot==null || snapshot.anchors<4 || snapshot.geometryAge>1400 || paused || snapshot.width<=0 || snapshot.height<=0) return;
        float scale=Math.min((float)getWidth()/snapshot.width,(float)getHeight()/snapshot.height);
        float dx=(getWidth()-snapshot.width*scale)/2,dy=(getHeight()-snapshot.height*scale)/2;
        outline.reset();
        for(int i=0;i<4;i++) {
            int n=ORDER[i]; float x=(float)snapshot.corners[n*2]*snapshot.width*scale+dx,y=(float)snapshot.corners[n*2+1]*snapshot.height*scale+dy;
            if(i==0) outline.moveTo(x,y); else outline.lineTo(x,y);
        }
        outline.close(); paint.setColor(good?0xDD4ADE80:0xDDD4A574); canvas.drawPath(outline,paint);
    }
}
