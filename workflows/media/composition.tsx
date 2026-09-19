import React, {useLayoutEffect, useRef, useState} from "react";
import {AbsoluteFill, Audio, Composition, Img, OffthreadVideo, Sequence, interpolate, registerRoot, staticFile, useCurrentFrame} from "remotion";
import type {PreparedStoryboard, PreparedScene} from "./storyboard";
import {inverse} from "./storyboard";
import {assertCaptionHeight, bodyRepeatsMatrixPanel, CAPTION_TOP, evidencePhase, evidenceTextScale, fitScale, inlineMatrices, MATRIX_TEXT_HEIGHT, matrixLetter, matrixPhaseLabel, PANEL_TOP} from "./layout";
import {MotionScene} from "./motion";
import {musicVolumeAt} from "./audio";

// Every frame is also watched inside a ~360px-wide phone player, so copy is
// set large, kept to one lane above the caption band and refused (not shrunk)
// when it would not fit.
const colors = {bg:"#0b1422", body:"#dbe5f1", muted:"#a9b8cc", text:"#f7f9fc", cyan:"#61ded8", gold:"#ffd174", line:"#2c4058"};
type Palette = typeof colors;
/** Matrix scenes inside a designed (editorial-cobalt) storyboard keep the
 * trusted legible layout but take the editorial palette so they sit beside
 * the motion scenes without a visual break. */
const editorialColors: Palette = {bg:"#111216", body:"#e4e0d6", muted:"#c1c1c7", text:"#f5f0e6", cyan:"#889aff", gold:"#ddd2ae", line:"#36373e"};
const font = "'Segoe UI', Arial, sans-serif";
const PAD=58, CONTENT_W=1280-2*PAD, PANEL_H=MATRIX_TEXT_HEIGHT, COPY_W=540, VIDEO_W=CONTENT_W-COPY_W-28, VIDEO_H=372;
const fmt = (n: number) => Number(n.toFixed(3)).toString().replace("-", "−");

function InlineMatrix({rows, palette=colors}: {rows: string[][]; palette?: Palette}) {
  return <span style={{display:"inline-grid",gridTemplateColumns:"auto auto",columnGap:"0.55em",rowGap:"0.04em",padding:"0.08em 0.4em",margin:"0 0.12em",borderLeft:`0.09em solid ${palette.cyan}`,borderRight:`0.09em solid ${palette.cyan}`,borderRadius:"0.18em",verticalAlign:"middle",lineHeight:1.12,textAlign:"center",whiteSpace:"nowrap"}}>{rows.flat().map((cell,i)=><span key={i}>{cell}</span>)}</span>;
}
/** Typeset [[a,b],[c,d]] notation as a real two-row matrix. */
function Rich({text, palette=colors}: {text: string; palette?: Palette}) {
  return <>{inlineMatrices(text).map((part,i)=>typeof part==="string"?<React.Fragment key={i}>{part}</React.Fragment>:<InlineMatrix key={i} rows={part.rows} palette={palette}/>)}</>;
}
function Matrix({value, label, palette=colors}: {value: number[][]; label: string; palette?: Palette}) {
  return <div style={{display:"flex",alignItems:"center",gap:14}}><span style={{fontSize:32,color:palette.body,whiteSpace:"nowrap"}}>{label}</span><div style={{display:"grid",gridTemplateColumns:"repeat(2, 66px)",textAlign:"center",gap:"6px 6px",borderLeft:`4px solid ${palette.cyan}`,borderRight:`4px solid ${palette.cyan}`,borderRadius:5,padding:"8px 12px",fontSize:38,fontWeight:600,lineHeight:1.15}}>{value.flat().map((x,i)=><span key={i}>{fmt(x)}</span>)}</div></div>;
}
/** Measure the copy once per scene (system fonts are local, layout is
 * synchronous before paint) and fit it to its lane as one unit. */
function Fit({children, width, height, identity, what, center}: {children: React.ReactNode; width: number; height: number; identity: string; what: string; center?: boolean}) {
  const content=useRef<any>(null), [scale,setScale]=useState(1);
  useLayoutEffect(()=>{ if(content.current) setScale(fitScale(content.current.scrollHeight,height,.8,what)); },[identity,height,what]);
  return <div data-fit-lane style={{width,height,display:"flex",flexDirection:"column",justifyContent:center?"center":"flex-start"}}>
    <div ref={content} data-fit-content style={{display:"flow-root",width,transform:`scale(${scale})`,transformOrigin:center?"left center":"top left"}}>{children}</div>
  </div>;
}
function Caption({text,sceneId,palette=colors}:{text:string;sceneId:string;palette?:Palette}) {
  const content=useRef<any>(null);
  useLayoutEffect(()=>{assertCaptionHeight(content.current.scrollHeight);},[text,sceneId]);
  return <div data-caption-safe-area style={{position:"absolute",left:PAD,width:CONTENT_W,top:CAPTION_TOP,fontSize:26,lineHeight:1.25,color:palette.text,borderTop:`1px solid ${palette.line}`,paddingTop:14}}><div ref={content}>{text}</div></div>;
}
function EvidenceText({children, height, identity}: {children: React.ReactNode; height:number; identity:string}) {
  const content=useRef<any>(null),[scale,setScale]=useState(1);
  useLayoutEffect(()=>{
    try {setScale(evidenceTextScale(content.current.scrollHeight,height));}
    catch(error) {throw new Error(`${identity}: ${String(error)} (measured ${content.current.scrollHeight}px; available ${height}px)`);}
  },[identity,height]);
  return <div style={{height}}><div ref={content} style={{display:"flow-root",transform:`scale(${scale})`,transformOrigin:"top left"}}>{children}</div></div>;
}
/** Evidence scenes keep the unchanged artifact image for the first 62% of the
 * scene, then give the supplied records their own readable panel. */
function EvidenceContent({scene, frame}: {scene:PreparedScene;frame:number}) {
  const evidence=scene.evidence??[], hasDetails=Boolean(scene.body||scene.bullets?.length||evidence.length);
  const phase=evidencePhase(frame,scene.frames,hasDetails);
  const runId=evidence.map(item=>item.source).join(" ").match(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i)?.[0];
  const source=[scene.artifactImage,runId].filter(Boolean).join(" · ");
  return <div data-evidence-layout={phase} style={{position:"absolute",left:PAD,width:CONTENT_W,top:52}}>
    <EvidenceText height={47} identity={`${scene.id}-heading`}><h1 style={{fontSize:39,lineHeight:1.12,fontWeight:650,letterSpacing:-1,margin:0}}>{scene.title}</h1></EvidenceText>
    {phase==="artifact" ? <>
      <div style={{height:28,fontSize:18,color:colors.cyan,lineHeight:1.3}}>{scene.artifactLabel}</div>
      <div data-evidence-image-panel style={{height:384,width:"100%",background:"#152334",border:"1px solid #284254",borderRadius:9,overflow:"hidden"}}><Img src={staticFile(scene.imageAsset!)} style={{width:"100%",height:"100%",objectFit:"contain"}}/></div>
      {source&&<div style={{marginTop:8,fontSize:18,lineHeight:1.2,color:colors.muted,overflowWrap:"anywhere"}}>{source}</div>}
    </> : <div style={{marginTop:26}}><EvidenceText height={412} identity={`${scene.id}-details`}>
      {scene.body&&<p style={{fontSize:30,lineHeight:1.3,color:colors.body,margin:"0 0 22px"}}>{scene.body}</p>}
      {Boolean(scene.bullets?.length)&&<ul style={{fontSize:27,lineHeight:1.35,margin:"0 0 24px",paddingLeft:30}}>{scene.bullets!.map((value,i)=><li key={i}>{value}</li>)}</ul>}
      <div style={{display:"grid",gridTemplateColumns:`repeat(${Math.max(1,evidence.length)}, minmax(0, 1fr))`,gap:36}}>{evidence.map((item,i)=><div key={i} style={{borderTop:`2px solid ${colors.cyan}`,paddingTop:22}}><div style={{fontSize:22,color:colors.cyan,marginBottom:16}}>{item.label}</div><div style={{fontSize:34,lineHeight:1.22,marginBottom:26}}>{item.value}</div><div style={{fontSize:20,lineHeight:1.35,color:colors.muted,overflowWrap:"anywhere"}}>{item.source}</div></div>)}</div>
      {scene.artifactLabel&&<div style={{fontSize:20,color:colors.cyan,marginTop:28}}>{scene.artifactLabel}</div>}
    </EvidenceText></div>}
  </div>;
}
function Scene({scene, index, total, editorial=false}: {scene: PreparedScene;index:number;total:number;editorial?:boolean}) {
  const palette=editorial?editorialColors:colors;
  const f=useCurrentFrame();
  const reveal=interpolate(f,[0,Math.min(14,scene.frames/5)],[0,1],{extrapolateRight:"clamp"});
  const matrix=scene.matrix;
  const inverseMatrix=matrix ? inverse(matrix) : null;
  const matrixMode=scene.visual==="matrix";
  const evidenceMode=scene.visual==="evidence"&&Boolean(scene.imageAsset);
  const big=scene.visual==="title"||scene.visual==="closing";
  const caption = scene.caption ?? "";
  const bullets=scene.bullets ?? [];
  const letter=matrixLetter([scene.body,scene.title,...bullets,scene.caption],scene.matrixName);
  const headingSize=big?72:matrixMode?48:54, bodySize=matrixMode?30:big?38:34, bulletSize=matrixMode?28:36;
  const heading=<h1 style={{fontSize:headingSize,lineHeight:1.1,fontWeight:700,margin:"0 0 18px",letterSpacing:-1.5,color:palette.text}}><Rich text={scene.title} palette={palette}/></h1>;
  const copy=<div style={{display:"flex",flexDirection:"column",gap:matrixMode?16:24,width:"100%"}}>
    {scene.body && !(matrixMode && bodyRepeatsMatrixPanel(scene.body)) && <p style={{color:palette.body,fontSize:bodySize,lineHeight:1.34,margin:0}}><Rich text={scene.body} palette={palette}/></p>}
    {bullets.length>0 && <div style={{display:"flex",flexDirection:"column",gap:matrixMode?12:18}}>{bullets.map((b,i)=><div key={i} style={{display:"flex",gap:16,alignItems:"flex-start",fontSize:bulletSize,lineHeight:1.3,opacity:interpolate(f,[8+i*6,18+i*6],[0,1],{extrapolateLeft:"clamp",extrapolateRight:"clamp"})}}><span style={{color:palette.cyan,fontSize:bulletSize*.55,paddingTop:bulletSize*.42,flexShrink:0}}>●</span><span><Rich text={b} palette={palette}/></span></div>)}</div>}
    {matrix && <div style={{display:"flex",flexWrap:"wrap",gap:"14px 26px",alignItems:"center",marginTop:6}}><Matrix value={matrix} label={`${letter} =`} palette={palette}/>{inverseMatrix ? <Matrix value={inverseMatrix} label={`${letter}⁻¹ =`} palette={palette}/> : <span style={{display:"inline-flex",flexDirection:"column",fontSize:30,lineHeight:1.2,color:palette.gold,fontWeight:600,whiteSpace:"nowrap"}}><span>det({letter}) = 0</span><span>no inverse</span></span>}</div>}
    {(scene.evidence?.length ?? 0)>0 && <div style={{display:"grid",gridTemplateColumns:`repeat(${scene.evidence!.length}, minmax(0, 1fr))`,gap:34,marginTop:8}}>{scene.evidence!.map((item,i)=><div key={i} style={{borderTop:`3px solid ${palette.cyan}`,padding:"18px 0 0"}}><div style={{fontSize:22,color:palette.cyan,marginBottom:12,letterSpacing:1}}>{item.label}</div><div style={{fontSize:36,lineHeight:1.2,marginBottom:14,fontWeight:600}}>{item.value}</div><div style={{fontSize:20,lineHeight:1.3,color:palette.muted,overflowWrap:"anywhere"}}>{item.source}</div></div>)}</div>}
  </div>;
  const phaseLabel=matrixPhaseLabel(f,scene.frames,Boolean(inverseMatrix)).replace(/\bA\b/g,letter);
  return <AbsoluteFill style={{background:palette.bg,color:palette.text,fontFamily:font,overflow:"hidden"}}>
    {!editorial&&<div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse at 90% 15%, #18384a 0%, transparent 60%)",opacity:.7}} />}
    <div style={{position:"absolute",left:PAD,top:26,fontSize:17,letterSpacing:editorial?2:4,color:palette.cyan,fontWeight:700}}>HANDS / {matrixMode ? "LINEAR ALGEBRA" : "STUDIO"}</div>
    <div style={{position:"absolute",right:PAD,top:26,color:palette.muted,fontSize:17}}>{String(index+1).padStart(2,"0")} / {String(total).padStart(2,"0")}</div>
    {evidenceMode?<EvidenceContent scene={scene} frame={f}/>:<div style={{position:"absolute",left:PAD,top:PANEL_TOP,width:CONTENT_W,height:PANEL_H,opacity:reveal,transform:`translateY(${(1-reveal)*14}px)`}}>
      <Fit width={CONTENT_W} height={PANEL_H} identity={scene.id} what={`Scene "${scene.id}" text`} center>
        {heading}
        {matrixMode ? <div style={{display:"flex",gap:28,alignItems:"flex-start"}}>
          <div style={{width:COPY_W,flexShrink:0}}>{copy}</div>
          {scene.videoAsset && <div style={{position:"relative",width:VIDEO_W,height:VIDEO_H,borderRadius:16,overflow:"hidden",border:"1px solid #24405a",background:palette.bg}}>
            <OffthreadVideo src={staticFile(scene.videoAsset)} muted style={{width:"100%",height:"100%",objectFit:"contain"}}/>
            <div style={{position:"absolute",bottom:12,right:14,fontSize:24,lineHeight:1.2,color:palette.cyan,background:"rgba(11,20,34,.82)",padding:"6px 14px",borderRadius:9,fontWeight:600}}>{phaseLabel}</div>
          </div>}
        </div>
        : scene.imageAsset ? <div style={{display:"flex",gap:32,alignItems:"flex-start"}}>
          <div style={{width:470,flexShrink:0}}>{copy}</div>
          <div style={{flex:1,minWidth:0,display:"flex",flexDirection:"column",gap:12}}><Img src={staticFile(scene.imageAsset)} style={{width:"100%",height:340,objectFit:"contain",background:"#ffffff",borderRadius:12,border:"1px solid #284254"}}/>{scene.artifactLabel&&<div style={{fontSize:22,color:palette.cyan}}>{scene.artifactLabel}</div>}</div>
        </div>
        : copy}
      </Fit>
    </div>}
    {caption && <Caption text={caption} sceneId={scene.id} palette={palette}/>}
    <div style={{position:"absolute",left:0,bottom:0,height:6,width:`${100*(index+f/scene.frames)/total}%`,background:editorial?"#2545ff":palette.cyan}}/>
    {scene.audioAsset && <Audio src={staticFile(scene.audioAsset)}/>}
  </AbsoluteFill>;
}
function Video({storyboard}: {storyboard: PreparedStoryboard}) {return <AbsoluteFill>{storyboard.scenes.map((scene,index)=><Sequence key={scene.id} from={scene.startFrame} durationInFrames={scene.frames}>{storyboard.design&&scene.visual!=="matrix"?<MotionScene scene={scene} index={index} total={storyboard.scenes.length} restrained={storyboard.design.motion==="restrained"}/>:<Scene scene={scene} index={index} total={storyboard.scenes.length} editorial={Boolean(storyboard.design)}/>}</Sequence>)}{storyboard.musicAsset&&<Audio src={staticFile(storyboard.musicAsset)} volume={frame=>musicVolumeAt(frame,storyboard)}/>}</AbsoluteFill>;}
const blank: PreparedStoryboard={version:1,title:"Hands Studio",kind:"pitch",width:1280,height:720,fps:24,sources:[],scenes:[],durationInFrames:24};
function Root() {return <Composition id="HandsStoryboard" component={Video} width={1280} height={720} fps={24} durationInFrames={24} defaultProps={{storyboard:blank}} calculateMetadata={({props})=>({durationInFrames:props.storyboard.durationInFrames,width:props.storyboard.width,height:props.storyboard.height,fps:props.storyboard.fps})}/>;}
registerRoot(Root);
