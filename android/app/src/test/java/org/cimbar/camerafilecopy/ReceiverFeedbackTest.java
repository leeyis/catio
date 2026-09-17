package org.cimbar.camerafilecopy;

import org.junit.Test;
import static org.junit.Assert.*;

public class ReceiverFeedbackTest {
    private double[] frame(long bytes,long scans,long decoded) {
        double[] d=new double[27]; d[1]=scans; d[3]=decoded; d[4]=bytes; d[5]=4; d[6]=1000; d[7]=1000;
        double[] corners={.2,.2,.8,.2,.2,.8,.8,.8}; System.arraycopy(corners,0,d,8,8); return d;
    }
    @Test public void duplicatePacketsDoNotInflateSpeedAndStallsReachZero() {
        TransferStats stats=new TransferStats(); stats.update(0,new ScanSnapshot(frame(0,0,0)),false);
        stats.update(1000,new ScanSnapshot(frame(2048,20,15)),false);
        assertEquals(2048,stats.bytesPerSecond,.01); assertEquals(75,stats.recognitionPercent);
        stats.update(2000,new ScanSnapshot(frame(2048,40,35)),false);
        stats.update(4000,new ScanSnapshot(frame(2048,80,75)),false);
        assertEquals(0,stats.bytesPerSecond,0); assertEquals(3000,stats.stalledMillis);
    }
    @Test public void pauseAndNativeResetDoNotCreateNegativeOrBurstRates() {
        TransferStats stats=new TransferStats(); stats.update(0,new ScanSnapshot(frame(5000,50,40)),false);
        stats.update(500,new ScanSnapshot(frame(6000,60,50)),false);
        stats.update(1000,new ScanSnapshot(frame(6000,60,50)),true); assertEquals(0,stats.bytesPerSecond,0);
        stats.update(2000,new ScanSnapshot(frame(6000,60,50)),false); assertEquals(0,stats.bytesPerSecond,0);
        stats.update(2500,new ScanSnapshot(frame(10,1,0)),false); assertEquals(0,stats.bytesPerSecond,0);
    }
    @Test public void missingCornersNeverInventADirection() {
        double[] d=frame(0,0,0); d[5]=3;
        assertEquals(ScanGuidance.Hint.INCOMPLETE,ScanGuidance.choose(new ScanSnapshot(d),new TransferStats(),false));
        d[5]=0; assertEquals(ScanGuidance.Hint.SEARCH,ScanGuidance.choose(new ScanSnapshot(d),new TransferStats(),false));
        d[18]=1; assertEquals(ScanGuidance.Hint.LOST,ScanGuidance.choose(new ScanSnapshot(d),new TransferStats(),false));
    }
    @Test public void staleGeometryNeverGivesDirectionalGuidance() {
        double[] d=frame(0,0,0); d[16]=1500; d[8]=.01;
        assertEquals(ScanGuidance.Hint.SEARCH,ScanGuidance.choose(new ScanSnapshot(d),new TransferStats(),false));
    }
    @Test public void distinguishesPositionDistanceAndPerspective() {
        double[] d=frame(0,0,0); for(int i=8;i<16;i+=2) d[i]-=.16;
        assertEquals(ScanGuidance.Hint.LEFT,ScanGuidance.choose(new ScanSnapshot(d),new TransferStats(),false));
        d=frame(0,0,0); for(int i=8;i<16;i+=2) d[i]+=.16;
        assertEquals(ScanGuidance.Hint.RIGHT,ScanGuidance.choose(new ScanSnapshot(d),new TransferStats(),false));
        d=frame(0,0,0); d[8]=.01;
        assertEquals(ScanGuidance.Hint.FARTHER,ScanGuidance.choose(new ScanSnapshot(d),new TransferStats(),false));
        d=frame(0,0,0); for(int i=8;i<16;i++) d[i]=.5+(d[i]-.5)*.5;
        assertEquals(ScanGuidance.Hint.CLOSER,ScanGuidance.choose(new ScanSnapshot(d),new TransferStats(),false));
        d=frame(0,0,0); d[12]=.35; d[14]=.65;
        assertEquals(ScanGuidance.Hint.STRAIGHTEN,ScanGuidance.choose(new ScanSnapshot(d),new TransferStats(),false));
    }
    @Test public void distinguishesRecognizedButRepeatedFramesFromLostSignal() {
        double[] d=frame(0,0,0); d[18]=1;
        TransferStats stats=new TransferStats(); stats.stalledMillis=3000; stats.sinceDecodeMillis=100;
        assertEquals(ScanGuidance.Hint.STALLED,ScanGuidance.choose(new ScanSnapshot(d),stats,false));
        stats.sinceDecodeMillis=2000; assertEquals(ScanGuidance.Hint.STEADY,ScanGuidance.choose(new ScanSnapshot(d),stats,false));
    }
    @Test public void finishingAndPauseHavePriorityOverMovementHints() {
        double[] d=frame(0,0,0); d[26]=1;
        assertEquals(ScanGuidance.Hint.FINISHING,ScanGuidance.choose(new ScanSnapshot(d),new TransferStats(),false));
        assertEquals(ScanGuidance.Hint.PAUSED,ScanGuidance.choose(new ScanSnapshot(d),new TransferStats(),true));
    }
    @Test public void progressNeverClaimsCompleteBeforeFileVerification() {
        double[] d=frame(0,0,0); d[17]=1.15;
        assertEquals(.99,new ScanSnapshot(d).progress,0);
    }
}
