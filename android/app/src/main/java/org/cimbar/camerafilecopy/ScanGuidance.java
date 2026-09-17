package org.cimbar.camerafilecopy;

final class ScanGuidance {
    enum Hint { SEARCH, INCOMPLETE, LEFT, RIGHT, UP, DOWN, CLOSER, FARTHER, STRAIGHTEN, STEADY, RECEIVING, STALLED, LOST, FINISHING, PAUSED }
    static Hint choose(ScanSnapshot s, TransferStats stats, boolean paused) {
        if (paused) return Hint.PAUSED;
        if (s.finishing) return Hint.FINISHING;
        if (s.geometryAge > 1400 || s.anchors < 4) {
            if (s.streams > 0) return Hint.LOST;
            return s.anchors > 0 && s.geometryAge < 1400 ? Hint.INCOMPLETE : Hint.SEARCH;
        }
        double minX=1,minY=1,maxX=0,maxY=0,cx=0,cy=0;
        for(int i=0;i<8;i+=2) {
            double x=s.corners[i], y=s.corners[i+1];
            if (Double.isNaN(x) || Double.isInfinite(x) || Double.isNaN(y) || Double.isInfinite(y)) return Hint.SEARCH;
            minX=Math.min(minX,x); maxX=Math.max(maxX,x); minY=Math.min(minY,y); maxY=Math.max(maxY,y); cx+=x/4; cy+=y/4;
        }
        if(minX<.025 || minY<.025 || maxX>.975 || maxY>.975) return Hint.FARTHER;
        double dx=cx-.5, dy=cy-.5;
        if(Math.abs(dx)>.13 || Math.abs(dy)>.13) {
            if(Math.abs(dx)>Math.abs(dy)) return dx<0?Hint.LEFT:Hint.RIGHT;
            return dy<0?Hint.UP:Hint.DOWN;
        }
        double top=distance(s,0,1), bottom=distance(s,2,3), left=distance(s,0,2), right=distance(s,1,3);
        if(Math.min(Math.min(top,bottom),Math.min(left,right))<1) return Hint.SEARCH;
        if(Math.max(top,bottom)/Math.min(top,bottom)>1.35 || Math.max(left,right)/Math.min(left,right)>1.35) return Hint.STRAIGHTEN;
        double span=Math.min(maxX*s.width-minX*s.width,maxY*s.height-minY*s.height);
        if(span/Math.max(1,Math.min(s.width,s.height))<.48) return Hint.CLOSER;
        if(s.streams>0 && stats.stalledMillis>2500) return stats.sinceDecodeMillis<1400?Hint.STALLED:Hint.STEADY;
        if(stats.sinceDecodeMillis<1400) return Hint.RECEIVING;
        return Hint.STEADY;
    }
    private static double distance(ScanSnapshot s,int a,int b) {
        return Math.hypot((s.corners[a*2]-s.corners[b*2])*s.width,(s.corners[a*2+1]-s.corners[b*2+1])*s.height);
    }
    private ScanGuidance() {}
}
