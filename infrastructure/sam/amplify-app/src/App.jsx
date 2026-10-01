// ============================================================
// SALT — Smart Asset Lifecycle Tracker
// Photo-first registration flow: upload photo → AI populates fields
// → user reviews/edits → saves asset
// Currency: USD ($)
// ============================================================

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Routes, Route, Navigate, NavLink, useNavigate, useParams } from 'react-router-dom';
import { Amplify } from 'aws-amplify';
import { Authenticator } from '@aws-amplify/ui-react';
import { getCurrentUser, fetchAuthSession, signOut } from 'aws-amplify/auth';
import '@aws-amplify/ui-react/styles.css';

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId:       import.meta.env.VITE_USER_POOL_ID,
      userPoolClientId: import.meta.env.VITE_CLIENT_ID,
      loginWith: {
        oauth: {
          domain:          'us-east-1l8wyacfeb.auth.us-east-1.amazoncognito.com',
          scopes:          ['email', 'openid', 'profile'],
          redirectSignIn:  [import.meta.env.VITE_APP_URL],
          redirectSignOut: [import.meta.env.VITE_APP_URL],
          responseType:    'code',
        },
      },
    },
  },
  API: {
    REST: {
      AssetAPI: {
        endpoint: import.meta.env.VITE_API_URL,
        region:   'us-east-1',
      },
    },
  },
});

const BASE_URL    = import.meta.env.VITE_API_URL || 'https://ri44266s4g.execute-api.us-east-1.amazonaws.com/Prod';
const CATEGORIES  = ['IT Equipment','Networking','Machinery','Vehicle','Furniture','Tools','Mobile Device','Printer','Server','Other'];
const STATUSES    = ['Available','Assigned','Checked Out','In Maintenance','Damaged','Lost','Stolen','Retired'];
const CONDITIONS  = ['Excellent','Good','Fair','Poor','Critical'];
const ENVIRONMENTS= ['Indoor','Outdoor','Both'];
const USAGE_LEVELS= ['Daily','Weekly','Monthly','Occasional'];
const MAINT_TYPES = ['Scheduled','Unscheduled','Repair','Cleaning','Inspection','Calibration','Replacement'];
const PERMISSIONS = {
  Administrator: ['read','create','update','delete','reports','manage'],
  Auditor:       ['read','reports'],
  Manager:       ['read','reports'],
  Technician:    ['read','update'],
  Employee:      ['read'],
};

// USD currency formatter
function fmtCurrency(val) {
  const n = parseFloat(val);
  return isNaN(n) ? '—' : '$' + n.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
}
function fmtDate(val) {
  if (!val || val === 'NOT-SET' || val === 'TBD') return '—';
  try { return new Date(val).toLocaleDateString('en-US', {day:'numeric', month:'short', year:'numeric'}); }
  catch { return val; }
}
function statusBadge(s) { return {Available:'badge-green',Assigned:'badge-blue','Checked Out':'badge-amber','In Maintenance':'badge-purple',Damaged:'badge-red',Lost:'badge-red',Stolen:'badge-red',Retired:'badge-gray'}[s]||'badge-gray'; }
function conditionBadge(c) { return {Excellent:'badge-green',Good:'badge-green',Fair:'badge-amber',Poor:'badge-red',Critical:'badge-red'}[c]||'badge-gray'; }
function priorityBadge(p) { return {Critical:'badge-red',High:'badge-amber',Medium:'badge-blue',Low:'badge-green'}[p]||'badge-gray'; }

async function getToken() { const s=await fetchAuthSession(); return s.tokens?.idToken?.toString()||''; }
async function req(method,path,body=null) {
  const token=await getToken();
  const opts={method,headers:{'Content-Type':'application/json',Authorization:token}};
  if(body) opts.body=JSON.stringify(body);
  const res=await fetch(`${BASE_URL}${path}`,opts);
  const data=await res.json();
  if(!res.ok) throw new Error(data.message||`HTTP ${res.status}`);
  return data;
}

const api = {
  getAssets:             ()        => req('GET',    '/assets').then(r=>r.assets||r),
  getAsset:              id        => req('GET',    `/assets/${id}`).then(r=>r.records||r),
  createAsset:           body      => req('POST',   '/assets', body),
  updateAsset:           (id,body) => req('PUT',    `/assets/${id}`, body),
  deleteAsset:           id        => req('DELETE', `/assets/${id}`),
  getHistory:            id        => req('GET',    `/assets/${id}/history`).then(r=>r.history||r),
  addMaintenance:        (id,body) => req('POST',   `/assets/${id}/maintenance`, body),
  getMaintenanceHistory: id        => req('GET',    `/assets/${id}/maintenance`).then(r=>r.maintenance_history||r),
  getRecommendation:     id        => req('GET',    `/assets/${id}/maintenance/recommendation`),
  refreshRecommendation: id        => req('POST',   `/assets/${id}/maintenance/recommendation`, {}),
  approveRecommendation: (id,body) => req('POST',   `/assets/${id}/maintenance/recommendation/approve`, body),
  triggerAiReview:       id        => req('POST',   `/assets/${id}/ai-review`, {}),
  getPhotoUrl:           (id,ct)   => req('POST',   `/assets/${id}/photo`, {content_type:ct}),
  search:                q         => req('GET',    `/assets/search?q=${encodeURIComponent(q)}`).then(r=>r.results||r),
  getByCategory:         cat       => req('GET',    `/assets/category/${encodeURIComponent(cat)}`).then(r=>r.assets||r),
  getByStatus:           status    => req('GET',    `/assets/status/${encodeURIComponent(status)}`).then(r=>r.assets||r),
  getByDepartment:       dept      => req('GET',    `/assets/department/${encodeURIComponent(dept)}`).then(r=>r.assets||r),
  getReports:            ()        => req('GET',    '/reports'),
};

// Upload photo with retry — returns {presigned_url, key, content_type}
async function getPresignedUrl(assetId, fileType, retries=2) {
  let lastError;
  for (let attempt=0; attempt<=retries; attempt++) {
    try { return await api.getPhotoUrl(assetId, fileType); }
    catch(e) {
      lastError = e;
      if (attempt < retries) await new Promise(r=>setTimeout(r, 1000*(attempt+1)));
    }
  }
  throw lastError;
}

async function putFileToS3(presignedUrl, file, contentType, retries=2) {
  let lastError;
  for (let attempt=0; attempt<=retries; attempt++) {
    try {
      const res = await fetch(presignedUrl, {
        method:  'PUT',
        body:    file,
        headers: { 'Content-Type': contentType },
      });
      if (!res.ok) throw new Error(`S3 upload failed with status ${res.status}`);
      return true;
    } catch(e) {
      lastError = e;
      if (attempt < retries) await new Promise(r=>setTimeout(r, 1000*(attempt+1)));
    }
  }
  throw lastError;
}

async function uploadPhotoToAsset(assetId, file) {
  const fileType    = file.type || 'image/jpeg';
  const urlData     = await getPresignedUrl(assetId, fileType);
  const contentType = urlData.content_type || fileType;
  await putFileToS3(urlData.presigned_url, file, contentType);
  return urlData.key;
}

function useAuth() {
  const [user,setUser]=useState(null); const [group,setGroup]=useState(null);
  const [email,setEmail]=useState(null); const [loading,setLoading]=useState(true);
  useEffect(()=>{(async()=>{
    try {
      const u=await getCurrentUser(); const s=await fetchAuthSession();
      const g=s.tokens?.idToken?.payload?.['cognito:groups']||[];
      setUser(u); setGroup(Array.isArray(g)?g[0]:g);
      setEmail(s.tokens?.idToken?.payload?.email||'');
    } catch { setUser(null); setGroup(null); setEmail(null); }
    finally { setLoading(false); }
  })();}, []);
  const can=action=>(PERMISSIONS[group]||[]).includes(action);
  return {user,group,email,loading,can};
}

function Spinner() { return <div style={{display:'flex',justifyContent:'center',padding:60}}><div className="spinner"/></div>; }
function Alert({type='error',children,style}) { return <div className={`alert alert-${type}`} style={style}>{children}</div>; }
function Badge({cls,children}) { return <span className={`badge ${cls}`}>{children}</span>; }
function Field({label,required,error,children}) {
  return (
    <div className="form-group">
      <label className="form-label">{label}{required&&<span style={{color:'var(--red)'}}> *</span>}</label>
      {children}
      {error&&<div style={{color:'var(--red)',fontSize:12,marginTop:4}}>{error}</div>}
    </div>
  );
}
function Card({title,action,children,style}) { return <div className="card" style={style}>{title&&<div className="card-header"><h2 className="mb-0">{title}</h2>{action}</div>}{children}</div>; }
function StatCard({label,value,sub}) { return <div className="stat-card"><div className="stat-label">{label}</div><div className="stat-value">{value}</div>{sub&&<div className="stat-sub">{sub}</div>}</div>; }
function InfoRow({label,value,mono}) { return <div style={{marginBottom:10}}><div className="text-sm text-lt" style={{marginBottom:2}}>{label}</div><div className={mono?'mono':''} style={{fontWeight:500}}>{value||'—'}</div></div>; }
function Grid({cols=2,children}) { return <div style={{display:'grid',gridTemplateColumns:`repeat(${cols},1fr)`,gap:'4px 24px'}}>{children}</div>; }
function Tabs({tabs,active,onChange}) { return <div className="tabs">{tabs.map(t=><button key={t} className={`tab ${active===t?'active':''}`} onClick={()=>onChange(t)}>{t.charAt(0).toUpperCase()+t.slice(1)}</button>)}</div>; }

function Layout({children}) {
  const {group,email,can}=useAuth(); const navigate=useNavigate(); const [signing,setSigning]=useState(false);
  const NAV=[{to:'/',label:'Dashboard',icon:'▦',always:true},{to:'/assets',label:'Assets',icon:'◈',always:true},{to:'/register',label:'Register Asset',icon:'+',perm:'create'},{to:'/reports',label:'Reports',icon:'◉',perm:'reports'}];
  async function handleSignOut(){setSigning(true);try{await signOut();navigate('/login');}catch{setSigning(false);}}
  return (
    <div style={{display:'flex',minHeight:'100vh'}}>
      <aside style={{width:224,minWidth:224,background:'var(--navy)',display:'flex',flexDirection:'column',position:'sticky',top:0,height:'100vh'}}>
        <div style={{padding:'20px 20px 16px',borderBottom:'1px solid rgba(255,255,255,.08)'}}>
          <div style={{fontSize:11,fontWeight:700,color:'rgba(255,255,255,.4)',letterSpacing:2,marginBottom:4}}>SALT</div>
          <div style={{fontSize:13,fontWeight:600,color:'#fff',lineHeight:1.3}}>Smart Asset<br/>Lifecycle Tracker</div>
        </div>
        <nav style={{padding:'12px 10px',flex:1}}>
          {NAV.map(item=>{if(!item.always&&!can(item.perm)) return null;return(
            <NavLink key={item.to} to={item.to} end={item.to==='/'}
              style={({isActive})=>({display:'flex',alignItems:'center',gap:10,padding:'9px 12px',borderRadius:6,marginBottom:2,textDecoration:'none',fontSize:13,fontWeight:500,color:isActive?'#fff':'rgba(255,255,255,.55)',background:isActive?'rgba(255,255,255,.10)':'transparent'})}>
              <span style={{fontSize:15}}>{item.icon}</span>{item.label}
            </NavLink>);})}
        </nav>
        <div style={{padding:'14px 16px',borderTop:'1px solid rgba(255,255,255,.08)'}}>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10}}>
            <div style={{width:32,height:32,borderRadius:'50%',background:'rgba(255,255,255,.12)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:13,fontWeight:700,color:'rgba(255,255,255,.8)',flexShrink:0}}>{email?.[0]?.toUpperCase()||'U'}</div>
            <div style={{overflow:'hidden'}}><div style={{fontSize:11,color:'rgba(255,255,255,.4)',marginBottom:1}}>{group}</div><div style={{fontSize:12,color:'rgba(255,255,255,.7)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{email}</div></div>
          </div>
          <button onClick={handleSignOut} disabled={signing} style={{width:'100%',padding:7,background:'rgba(255,255,255,.06)',color:'rgba(255,255,255,.6)',border:'none',borderRadius:6,fontSize:12,cursor:'pointer'}}>{signing?'Signing out…':'Sign out'}</button>
        </div>
      </aside>
      <main style={{flex:1,overflow:'auto',padding:'28px 32px',minWidth:0}}>{children}</main>
    </div>
  );
}

function Dashboard() {
  const {can,email,group}=useAuth();
  const [assets,setAssets]=useState([]); const [stats,setStats]=useState(null);
  const [loading,setLoading]=useState(true); const [error,setError]=useState('');
  useEffect(()=>{(async()=>{try{const[a,r]=await Promise.all([api.getAssets(),can('reports')?api.getReports():null]);setAssets(Array.isArray(a)?a:[]);setStats(r);}catch(e){setError(e.message);}finally{setLoading(false);}})();},[]);
  if(loading) return <Spinner/>;
  const recent=[...assets].sort((a,b)=>(b.created_at||'').localeCompare(a.created_at||'')).slice(0,8);
  return (
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:24}}>
        <div><h1 style={{marginBottom:4}}>Dashboard</h1><p className="text-lt text-sm">Welcome back{email?`, ${email.split('@')[0]}`:''} — {group}</p></div>
        {can('create')&&<NavLink to="/register"><button className="btn-primary">+ Register Asset</button></NavLink>}
      </div>
      {error&&<Alert>{error}</Alert>}
      <div className="stat-grid" style={{marginBottom:24}}>
        <StatCard label="Total Assets" value={assets.length} sub="registered assets"/>
        {stats&&<><StatCard label="Total Book Value" value={fmtCurrency(stats.total_book_value)} sub="current depreciated value"/><StatCard label="Total Purchase Cost" value={fmtCurrency(stats.total_purchase_cost)} sub="original investment"/><StatCard label="Total Depreciation" value={fmtCurrency(stats.total_depreciation)} sub="accumulated to date"/></>}
      </div>
      <Card title="Recent Assets" action={<NavLink to="/assets" style={{fontSize:13,color:'var(--blue)',textDecoration:'none'}}>View all</NavLink>}>
        {recent.length===0?<div className="empty-state"><h3>No assets yet</h3></div>:
        <div className="table-wrap"><table><thead><tr><th>Asset ID</th><th>Name</th><th>Category</th><th>Manufacturer</th><th>In Service</th><th></th></tr></thead>
        <tbody>{recent.map(a=><tr key={a.asset_id}><td><span className="mono">{a.asset_id}</span></td><td style={{fontWeight:500}}>{a.name}</td><td>{a.category}</td><td>{a.manufacturer}</td><td>{fmtDate(a.in_service_date)}</td><td><NavLink to={`/assets/${a.asset_id}`}><button className="btn-secondary btn-sm">View</button></NavLink></td></tr>)}</tbody>
        </table></div>}
      </Card>
    </div>
  );
}

function AssetList() {
  const {can}=useAuth();
  const [assets,setAssets]=useState([]); const [loading,setLoading]=useState(true);
  const [error,setError]=useState(''); const [search,setSearch]=useState('');
  const [catFilter,setCatFilter]=useState(''); const [statFilter,setStatFilter]=useState('');
  const [deleting,setDeleting]=useState(null);
  const load=useCallback(async()=>{setLoading(true);setError('');try{let data;if(search.trim())data=await api.search(search.trim());else if(catFilter)data=await api.getByCategory(catFilter);else if(statFilter)data=await api.getByStatus(statFilter);else data=await api.getAssets();const arr=Array.isArray(data)?data:(data.assets||data.results||[]);setAssets(arr.filter(i=>!i.record_type||i.record_type==='PROFILE'));}catch(e){setError(e.message);}finally{setLoading(false);}},[ search,catFilter,statFilter]);
  useEffect(()=>{load();},[load]);
  async function handleDelete(id){if(!window.confirm(`Permanently delete asset ${id}?`)) return;setDeleting(id);try{await api.deleteAsset(id);setAssets(p=>p.filter(a=>a.asset_id!==id));}catch(e){setError(e.message);}finally{setDeleting(null);}}
  const hasFilter=search||catFilter||statFilter;
  return (
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:20}}>
        <h1>Assets</h1>
        {can('create')&&<NavLink to="/register"><button className="btn-primary">+ Register Asset</button></NavLink>}
      </div>
      <Card style={{marginBottom:16}}>
        <div style={{display:'grid',gridTemplateColumns:'1fr auto auto auto',gap:10,alignItems:'center'}}>
          <input placeholder="Search by name, manufacturer, model, serial number…" value={search} onChange={e=>{setSearch(e.target.value);setCatFilter('');setStatFilter('');}}/>
          <select value={catFilter} onChange={e=>{setCatFilter(e.target.value);setSearch('');setStatFilter('');}} style={{width:180}}><option value="">All categories</option>{CATEGORIES.map(c=><option key={c}>{c}</option>)}</select>
          <select value={statFilter} onChange={e=>{setStatFilter(e.target.value);setSearch('');setCatFilter('');}} style={{width:160}}><option value="">All statuses</option>{STATUSES.map(s=><option key={s}>{s}</option>)}</select>
          {hasFilter&&<button className="btn-secondary btn-sm" onClick={()=>{setSearch('');setCatFilter('');setStatFilter('');}}>Clear</button>}
        </div>
      </Card>
      {error&&<Alert>{error}</Alert>}
      {loading?<Spinner/>:assets.length===0?<Card><div className="empty-state"><h3>No assets found</h3></div></Card>:
      <Card><div className="table-wrap"><table>
        <thead><tr><th>Asset ID</th><th>Name</th><th>Category</th><th>Manufacturer</th><th>Status</th><th>In Service</th><th></th></tr></thead>
        <tbody>{assets.map(a=><tr key={a.asset_id}><td><span className="mono">{a.asset_id}</span></td><td style={{fontWeight:500}}>{a.name}</td><td>{a.category}</td><td>{a.manufacturer}</td><td><Badge cls={statusBadge(a.status)}>{a.status||'—'}</Badge></td><td>{fmtDate(a.in_service_date)}</td>
        <td><div className="gap-8"><NavLink to={`/assets/${a.asset_id}`}><button className="btn-secondary btn-sm">View</button></NavLink>{can('update')&&<NavLink to={`/assets/${a.asset_id}/edit`}><button className="btn-secondary btn-sm">Edit</button></NavLink>}{can('delete')&&<button className="btn-danger btn-sm" disabled={deleting===a.asset_id} onClick={()=>handleDelete(a.asset_id)}>{deleting===a.asset_id?'…':'Delete'}</button>}</div></td>
        </tr>)}</tbody>
      </table></div></Card>}
    </div>
  );
}

function AssetDetail() {
  const {id}=useParams(); const navigate=useNavigate(); const {can}=useAuth();
  const [records,setRecords]=useState([]); const [rec,setRec]=useState(null);
  const [loading,setLoading]=useState(true); const [tab,setTab]=useState('overview');
  const [error,setError]=useState(''); const [refreshing,setRefreshing]=useState(false);
  const [aiReviewing,setAiReviewing]=useState(false); const [aiSuggestions,setAiSuggestions]=useState(null);
  const [aiError,setAiError]=useState(''); const [accepting,setAccepting]=useState(false);
  const [approving,setApproving]=useState(false);
  const [maintHistory,setMaintHistory]=useState([]); const [maintLoading,setMaintLoading]=useState(false);
  const [maintError,setMaintError]=useState('');

  useEffect(()=>{(async()=>{try{const[recs,recommendation]=await Promise.all([api.getAsset(id),api.getRecommendation(id).catch(()=>null)]);setRecords(Array.isArray(recs)?recs:[]);setRec(recommendation);}catch(e){setError(e.message);}finally{setLoading(false);}})();},[id]);
  useEffect(()=>{if(tab==='maintenance'&&maintHistory.length===0){(async()=>{setMaintLoading(true);setMaintError('');try{const h=await api.getMaintenanceHistory(id);setMaintHistory(Array.isArray(h)?h:[]);}catch(e){setMaintError(e.message);}finally{setMaintLoading(false);}})();}},[ tab,id]);

  async function refresh(){setRefreshing(true);try{setRec(await api.refreshRecommendation(id));}catch(e){setError(e.message);}finally{setRefreshing(false);}}

  async function handleAiReview(){
    setAiReviewing(true);setAiError('');setAiSuggestions(null);
    try{
      const result=await api.triggerAiReview(id);
      if(result.manual_entry_required||result.identification_status==='manual_entry_required'){
        setAiError(result.message||'Could not identify asset from photograph. Please enter details manually.');
      } else {
        setAiSuggestions(result.suggestions);
      }
    }catch(e){setAiError(e.message);}
    finally{setAiReviewing(false);}
  }

  async function acceptSuggestions(){
    setAccepting(true);
    try{
      await api.updateAsset(id,{category:aiSuggestions.category,condition:aiSuggestions.condition,description:aiSuggestions.description});
      setAiSuggestions(null);
      const recs=await api.getAsset(id);setRecords(Array.isArray(recs)?recs:[]);
    }catch(e){setAiError(e.message);}
    finally{setAccepting(false);}
  }

  function editSuggestions(){sessionStorage.setItem('aiSuggestions',JSON.stringify(aiSuggestions));navigate(`/assets/${id}/edit`);}
  function rejectSuggestions(){setAiSuggestions(null);setAiError('');sessionStorage.setItem('aiRejected','true');navigate(`/assets/${id}/edit`);}

  async function handleApproveRecommendation(){
    setApproving(true);
    try{
      const result=await api.approveRecommendation(id,{});
      setRec(r=>({...r,approval_status:'Approved',approved_by:result.approved_by,next_maintenance_due:result.next_maintenance_due}));
    }catch(e){setError(e.message);}
    finally{setApproving(false);}
  }

  if(loading) return <Spinner/>;
  if(error)   return <Alert>{error}</Alert>;

  const profile    = records.find(r=>r.record_type==='PROFILE')    ||{};
  const financials = records.find(r=>r.record_type==='FINANCIALS') ||{};
  const status     = records.find(r=>r.record_type==='STATUS')     ||{};
  const locations  = records.filter(r=>r.record_type?.startsWith('LOCATION#')).sort((a,b)=>b.event_date?.localeCompare(a.event_date||'')||0);
  const location   = locations[0]||{};

  return (
    <div>
      <div style={{display:'flex',gap:12,alignItems:'flex-start',marginBottom:24}}>
        <button className="btn-icon" onClick={()=>navigate('/assets')}>←</button>
        <div style={{flex:1}}>
          <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:4}}>
            <h1 style={{margin:0}}>{profile.name}</h1>
            <Badge cls={statusBadge(status.status)}>{status.status||'—'}</Badge>
          </div>
          <div className="text-lt text-sm"><span className="mono">{id}</span>{profile.category&&` · ${profile.category}`}</div>
        </div>
        <div className="gap-8">
          {can('update')&&<NavLink to={`/assets/${id}/edit`}><button className="btn-secondary">Edit</button></NavLink>}
          {can('update')&&<NavLink to={`/assets/${id}/maintenance`}><button className="btn-secondary">Log Maintenance</button></NavLink>}
        </div>
      </div>

      <Tabs tabs={['overview','financials','location','maintenance','history']} active={tab} onChange={setTab}/>

      {tab==='overview'&&(
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:20}}>
          <div>
            <Card title="Asset Information" style={{marginBottom:16}}>
              <Grid><InfoRow label="Name" value={profile.name}/><InfoRow label="Category" value={profile.category}/><InfoRow label="Manufacturer" value={profile.manufacturer}/><InfoRow label="Model" value={profile.model}/><InfoRow label="Serial Number" value={profile.serial_number} mono/><InfoRow label="Asset Tag" value={profile.asset_tag} mono/></Grid>
              <InfoRow label="Description" value={profile.description}/>
              <Grid><InfoRow label="Acquired" value={fmtDate(profile.acquired_date)}/><InfoRow label="In Service" value={fmtDate(profile.in_service_date)}/></Grid>
            </Card>

            {can('update')&&(
              <Card title="AI Image Analysis">
                {aiError&&(
                  <Alert type="info" style={{marginBottom:12}}>
                    {aiError}
                    <div style={{marginTop:8}}>
                      <button className="btn-secondary btn-sm" onClick={()=>navigate(`/assets/${id}/edit`)}>Enter Details Manually</button>
                    </div>
                  </Alert>
                )}
                {!aiSuggestions?(
                  <div>
                    <p className="text-sm text-lt" style={{marginBottom:12}}>Run AI analysis on the uploaded photo to get suggested category, condition and description.</p>
                    {profile.ai_review_status&&profile.ai_review_status!=='Pending'&&(
                      <div style={{marginBottom:12,fontSize:12,color:'var(--text-lt)'}}>Last review: <strong>{profile.ai_review_status}</strong></div>
                    )}
                    <button className="btn-secondary" onClick={handleAiReview} disabled={aiReviewing}>{aiReviewing?'🔄 Analysing…':'🔍 Run AI Analysis'}</button>
                  </div>
                ):(
                  <div>
                    <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:14}}>
                      <Badge cls={aiSuggestions.identificationStatus==='suggestion_available'?'badge-green':'badge-amber'}>
                        {aiSuggestions.identificationStatus==='suggestion_available'?'Identified':'Review Needed'}
                      </Badge>
                      <span style={{fontSize:12,color:'var(--text-lt)'}}>Review before approving</span>
                    </div>
                    {aiSuggestions.visibleConditionNotes&&<Alert type="info" style={{marginBottom:12}}>{aiSuggestions.visibleConditionNotes}</Alert>}
                    <Grid>
                      <InfoRow label="Suggested Category"  value={aiSuggestions.category}/>
                      <InfoRow label="Suggested Condition" value={aiSuggestions.condition}/>
                      <InfoRow label="Manufacturer"        value={aiSuggestions.manufacturer}/>
                      <InfoRow label="Model"               value={aiSuggestions.model}/>
                      <InfoRow label="Useful Life"         value={aiSuggestions.useful_life_months?`${aiSuggestions.useful_life_months} months`:'-'}/>
                    </Grid>
                    <InfoRow label="Description" value={aiSuggestions.description}/>
                    {aiSuggestions.reviewNotes?.length>0&&(
                      <div style={{marginTop:8,marginBottom:8}}>
                        <div className="text-sm text-lt" style={{marginBottom:4}}>AI Notes</div>
                        {aiSuggestions.reviewNotes.map((note,i)=><div key={i} style={{fontSize:13,color:'var(--text-lt)',marginBottom:2}}>• {note}</div>)}
                      </div>
                    )}
                    <div style={{display:'flex',gap:8,marginTop:16,paddingTop:12,borderTop:'1px solid var(--border)',flexWrap:'wrap'}}>
                      <button className="btn-primary" onClick={acceptSuggestions} disabled={accepting}>{accepting?'Saving…':'✓ Approve'}</button>
                      <button className="btn-secondary" onClick={editSuggestions}>✎ Edit</button>
                      <button className="btn-danger btn-sm" onClick={rejectSuggestions}>✗ Reject — Enter Manually</button>
                      <button className="btn-secondary" onClick={handleAiReview} disabled={aiReviewing}>{aiReviewing?'…':'↺ Re-run'}</button>
                    </div>
                  </div>
                )}
              </Card>
            )}
          </div>

          <div>
            <Card title="Status and Location" style={{marginBottom:16}}>
              <Grid>
                <InfoRow label="Status"      value={<Badge cls={statusBadge(status.status)}>{status.status||'—'}</Badge>}/>
                <InfoRow label="Condition"   value={<Badge cls={conditionBadge(location.condition)}>{location.condition||'—'}</Badge>}/>
                <InfoRow label="Building"    value={location.building}/>
                <InfoRow label="Room"        value={location.room}/>
                <InfoRow label="Assigned To" value={location.assigned_to}/>
                <InfoRow label="Department"  value={location.assigned_department}/>
              </Grid>
            </Card>
            {rec&&(
              <Card title="Maintenance Recommendation" action={can('update')&&<button className="btn-secondary btn-sm" onClick={refresh} disabled={refreshing}>{refreshing?'…':'Refresh'}</button>}>
                <div className="gap-8" style={{marginBottom:10}}>
                  <Badge cls={priorityBadge(rec.priority||rec.maintenance_priority)}>{rec.priority||rec.maintenance_priority} Priority</Badge>
                  <Badge cls={rec.approval_status==='Approved'?'badge-green':'badge-amber'}>{rec.approval_status||'Pending Approval'}</Badge>
                </div>
                <p style={{fontSize:13,marginBottom:12}}>{rec.recommended_action||rec.recommendedAction}</p>
                {rec.reason&&<p style={{fontSize:12,color:'var(--text-lt)',marginBottom:12}}>{rec.reason}</p>}
                <Grid>
                  <InfoRow label="Interval"   value={rec.suggested_interval_days?`${rec.suggested_interval_days} days`:rec.suggested_maintenance_interval}/>
                  <InfoRow label="Next Due"   value={fmtDate(rec.next_maintenance_due||rec.recommended_completion_date)}/>
                  <InfoRow label="Replacement" value={rec.replacement_recommendation||rec.expected_replacement_window}/>
                </Grid>
                {rec.limitations&&(
                  <div style={{marginTop:8}}>
                    <div className="text-sm text-lt" style={{marginBottom:4}}>Limitations</div>
                    {(typeof rec.limitations==='string'?JSON.parse(rec.limitations):rec.limitations).map((l,i)=>(
                      <div key={i} style={{fontSize:12,color:'var(--text-lt)',marginBottom:2}}>• {l}</div>
                    ))}
                  </div>
                )}
                {can('update')&&rec.approval_status!=='Approved'&&(
                  <button className="btn-primary btn-sm" style={{marginTop:12}} onClick={handleApproveRecommendation} disabled={approving}>
                    {approving?'Approving…':'✓ Approve Recommendation'}
                  </button>
                )}
                {rec.approval_status==='Approved'&&(
                  <div style={{marginTop:8,fontSize:12,color:'var(--text-lt)'}}>Approved by {rec.approved_by}</div>
                )}
              </Card>
            )}
          </div>
        </div>
      )}

      {tab==='financials'&&(
        <Card>
          <h3 style={{marginBottom:12}}>Purchase and Depreciation</h3>
          <Grid cols={3}>
            <InfoRow label="Purchase Value" value={fmtCurrency(financials.purchase_value)}/>
            <InfoRow label="Salvage Value"  value={fmtCurrency(financials.salvage_value)}/>
            <InfoRow label="Useful Life"    value={financials.useful_life_months?`${financials.useful_life_months} months (${(financials.useful_life_months/12).toFixed(1)} yrs)`:financials.useful_life_years?`${financials.useful_life_years} years`:'—'}/>
          </Grid>
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:12,margin:'16px 0'}}>
            {[['Annual Depreciation',fmtCurrency(financials.annual_depreciation)],['Accumulated',fmtCurrency(financials.accumulated_depreciation)],['Current Book Value',fmtCurrency(financials.current_book_value)]].map(([label,val])=>(
              <div key={label} style={{padding:'14px 16px',background:'var(--surface)',borderRadius:'var(--radius)',border:'1px solid var(--border)'}}>
                <div className="stat-label">{label}</div>
                <div style={{fontSize:'1.2rem',fontWeight:700,color:'var(--navy)'}}>{val}</div>
              </div>
            ))}
          </div>
          {financials.useful_life_consumed_pct!==undefined&&(
            <div style={{marginBottom:16}}>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:6,fontSize:13}}>
                <span>Useful Life Consumed</span>
                <span style={{fontWeight:600}}>{parseFloat(financials.useful_life_consumed_pct||0).toFixed(1)}%</span>
              </div>
              <div style={{height:8,background:'var(--border)',borderRadius:4,overflow:'hidden'}}>
                <div style={{height:'100%',width:`${Math.min(100,parseFloat(financials.useful_life_consumed_pct||0))}%`,background:parseFloat(financials.useful_life_consumed_pct)>=85?'var(--red)':parseFloat(financials.useful_life_consumed_pct)>=60?'var(--amber)':'var(--blue)'}}/>
              </div>
            </div>
          )}
          <Grid cols={3}>
            <InfoRow label="In Service (Depreciation Start)" value={fmtDate(financials.in_service_date)}/>
            <InfoRow label="Estimated Replacement"           value={fmtDate(financials.estimated_replacement_date||financials.estimated_replacement)}/>
            <InfoRow label="Last Calculated"                 value={fmtDate(financials.last_calculated_date)}/>
            <InfoRow label="Warranty Expires"                value={fmtDate(financials.warranty_expiration)}/>
            <InfoRow label="Number of Repairs"               value={financials.number_of_repairs??'0'}/>
            <InfoRow label="Total Repair Cost"               value={fmtCurrency(financials.total_repair_cost)}/>
          </Grid>
        </Card>
      )}

      {tab==='location'&&(
        <Card title="Location History">
          {locations.length===0?<p className="text-lt">No location records.</p>:
          locations.map((loc,i)=>(
            <div key={i} style={{padding:'14px 0',borderBottom:i<locations.length-1?'1px solid var(--border)':'none'}}>
              <div style={{fontSize:12,color:'var(--text-lt)',marginBottom:8}}>{fmtDate(loc.event_date)}</div>
              <Grid cols={3}><InfoRow label="Building" value={loc.building}/><InfoRow label="Floor" value={loc.floor}/><InfoRow label="Room" value={loc.room}/><InfoRow label="Assigned To" value={loc.assigned_to}/><InfoRow label="Department" value={loc.assigned_department}/><InfoRow label="Condition" value={loc.condition}/></Grid>
            </div>
          ))}
        </Card>
      )}

      {tab==='maintenance'&&(
        <div>
          {can('update')&&<div style={{marginBottom:16}}><NavLink to={`/assets/${id}/maintenance`}><button className="btn-primary">+ Log Maintenance</button></NavLink></div>}
          {maintError&&<Alert>{maintError}</Alert>}
          {maintLoading?<Spinner/>:(
            <Card title="Maintenance History">
              {maintHistory.length===0?<div className="empty-state"><h3>No maintenance records</h3></div>:
              <div className="table-wrap"><table>
                <thead><tr><th>ID</th><th>Date</th><th>Type</th><th>Performed By</th><th>Cost</th><th>Condition After</th><th>Next Due</th><th>Notes</th></tr></thead>
                <tbody>{maintHistory.map((m,i)=>(
                  <tr key={i}>
                    <td><span className="mono text-sm">{m.maintenance_id||'—'}</span></td>
                    <td>{fmtDate(m.performed_date||m.event_date)}</td>
                    <td>{m.maintenance_type}</td>
                    <td>{m.performed_by}</td>
                    <td>{fmtCurrency(m.maintenance_cost)}</td>
                    <td>{m.condition_after_service?<Badge cls={conditionBadge(m.condition_after_service)}>{m.condition_after_service}</Badge>:'—'}</td>
                    <td>{fmtDate(m.next_due_date)}</td>
                    <td className="text-lt">{m.notes||'—'}</td>
                  </tr>
                ))}</tbody>
              </table></div>}
            </Card>
          )}
        </div>
      )}

      {tab==='history'&&(
        <Card title="Full Asset Timeline">
          <div className="table-wrap"><table>
            <thead><tr><th>Date</th><th>Record Type</th><th>Key Details</th></tr></thead>
            <tbody>{[...records].sort((a,b)=>(b.event_date||'').localeCompare(a.event_date||'')).map((r,i)=>(
              <tr key={i}><td>{fmtDate(r.event_date)}</td><td><span className="mono text-sm">{r.record_type}</span></td>
              <td className="text-lt text-sm">
                {r.record_type==='PROFILE'&&`${r.name} — ${r.category}`}
                {r.record_type==='FINANCIALS'&&`Book value: ${fmtCurrency(r.current_book_value)}`}
                {r.record_type==='STATUS'&&`Status: ${r.status}`}
                {r.record_type?.startsWith('LOCATION#')&&`${r.building} — ${r.room}`}
                {r.record_type?.startsWith('MAINTENANCE#')&&`${r.maintenance_type} — ${fmtCurrency(r.maintenance_cost)}`}
                {r.record_type==='MAINTENANCE_RECOMMENDATION'&&`${r.priority}: ${r.recommended_action}`}
              </td></tr>
            ))}</tbody>
          </table></div>
        </Card>
      )}
    </div>
  );
}

// ============================================================
// REGISTER ASSET — Photo-first flow
// Step 1: Upload photo (optional) → AI auto-populates fields
// Step 2: Review/edit Details (pre-filled by AI or manual)
// Step 3: Financial information
// Step 4: Location information
// Step 5: Review and confirm
// ============================================================
function RegisterAsset() {
  const navigate  = useNavigate();
  const fileRef   = useRef(null);
  const [step,    setStep]    = useState(1);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState('');
  const [fieldErrors,setFieldErrors] = useState({});

  // Photo state
  const [photoFile,      setPhotoFile]      = useState(null);
  const [photoPreview,   setPhotoPreview]   = useState(null);
  const [photoError,     setPhotoError]     = useState('');
  const [analyzing,      setAnalyzing]      = useState(false);
  const [aiDone,         setAiDone]         = useState(false);
  const [aiStatus,       setAiStatus]       = useState(''); // 'success' | 'manual' | 'skipped'
  const [tempAssetId,    setTempAssetId]    = useState(null); // created on photo upload

  const [form, setForm] = useState({
    name:'', category:'IT Equipment', manufacturer:'', model:'',
    serial_number:'', asset_tag:'', description:'',
    acquired_date:'', in_service_date:'',
    purchase_value:'', purchase_date:'', salvage_value:'',
    useful_life_months:'', warranty_expiration:'',
    status:'Available', condition:'Good', usage_level:'Daily', environment:'Indoor',
    building:'', floor:'', room:'', assigned_to:'', assigned_department:'',
  });
  const set = (k,v) => setForm(p=>({...p,[k]:v}));

  // ── Step 1: Photo upload and AI analysis ──────────────────
  function handlePhotoSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoFile(file); setPhotoError('');
    const r = new FileReader(); r.onload = ev => setPhotoPreview(ev.target.result); r.readAsDataURL(file);
  }

  async function handleAnalyze() {
    if (!photoFile) { setStep(2); setAiStatus('skipped'); return; }
    setAnalyzing(true); setPhotoError('');
    try {
      // Create a temporary asset record to get an ID for photo upload
      const tempResult = await api.createAsset({
        name:          'PENDING',
        acquired_date: new Date().toISOString().slice(0,10),
        in_service_date: new Date().toISOString().slice(0,10),
        status:        'Available',
        category:      'Other',
      });
      const tId = tempResult.asset_id;
      setTempAssetId(tId);

      // Upload photo to S3
      const key = await uploadPhotoToAsset(tId, photoFile);
      await api.updateAsset(tId, {image_key: key});

      // Trigger AI analysis
      const aiResult = await api.triggerAiReview(tId);

      if (aiResult.manual_entry_required || aiResult.identification_status === 'manual_entry_required') {
        setAiStatus('manual');
        setAiDone(true);
        setStep(2);
        return;
      }

      // Pre-populate form with AI suggestions
      const s = aiResult.suggestions || {};
      setForm(p => ({
        ...p,
        category:            s.category    || p.category,
        manufacturer:        s.manufacturer|| p.manufacturer,
        model:               s.model       || p.model,
        description:         s.description || p.description,
        condition:           s.condition   || p.condition,
        useful_life_months:  s.useful_life_months ? String(s.useful_life_months) : p.useful_life_months,
      }));
      setAiStatus('success');
      setAiDone(true);
      setStep(2);
    } catch(e) {
      setPhotoError(`Photo upload or AI analysis failed: ${e.message}. You can continue without AI suggestions.`);
      setAiStatus('manual');
      setAiDone(true);
      setStep(2);
    } finally {
      setAnalyzing(false);
    }
  }

  function skipPhoto() { setAiStatus('skipped'); setStep(2); }

  // ── Validation ────────────────────────────────────────────
  function validate() {
    const errs = {};
    if (!form.name.trim())      errs.name           = 'Asset name is required';
    if (!form.acquired_date)    errs.acquired_date   = 'Acquisition date is required';
    if (!form.in_service_date)  errs.in_service_date = 'In-service date is required';
    if (!form.purchase_date)    errs.purchase_date   = 'Purchase date is required';
    const pv = parseFloat(form.purchase_value);
    const sv = parseFloat(form.salvage_value);
    const ul = parseInt(form.useful_life_months);
    if (isNaN(pv)||pv<0)        errs.purchase_value    = 'Purchase value must be a positive number';
    if (isNaN(sv)||sv<0)        errs.salvage_value     = 'Salvage value must be a positive number';
    if (!isNaN(pv)&&!isNaN(sv)&&sv>pv) errs.salvage_value = 'Salvage value cannot exceed purchase value';
    if (isNaN(ul)||ul<=0)       errs.useful_life_months = 'Useful life must be greater than zero';
    return errs;
  }

  // ── Final save ────────────────────────────────────────────
  async function handleSubmit() {
    const errs = validate();
    if (Object.keys(errs).length) { setFieldErrors(errs); return; }
    setSaving(true); setError(''); setFieldErrors({});
    try {
      const payload = {
        ...form,
        purchase_value:     parseFloat(form.purchase_value),
        salvage_value:      parseFloat(form.salvage_value),
        useful_life_months: parseInt(form.useful_life_months),
      };

      let finalId = tempAssetId;

      if (tempAssetId) {
        // Update the temporary asset created during photo upload
        await api.updateAsset(tempAssetId, {...payload, record_type: 'PROFILE'});
        if (payload.purchase_value) {
          await api.updateAsset(tempAssetId, {...payload, record_type: 'FINANCIALS'});
        }
        await api.updateAsset(tempAssetId, {...payload, record_type: 'STATUS'});
      } else {
        // No photo — create fresh
        const result = await api.createAsset(payload);
        finalId = result.asset_id;
      }

      navigate(`/assets/${finalId}`);
    } catch(e) {
      setError(e.message);
      setSaving(false);
    }
  }

  const estMonthly = form.purchase_value && form.salvage_value && form.useful_life_months
    ? (((parseFloat(form.purchase_value)||0)-(parseFloat(form.salvage_value)||0))/(parseInt(form.useful_life_months)||1)).toFixed(2) : null;
  const estAnnual  = estMonthly ? (parseFloat(estMonthly)*12).toFixed(2) : null;

  const steps = ['Photo & AI','Details','Financial','Location','Confirm'];

  return (
    <div style={{maxWidth:780}}>
      <h1 style={{marginBottom:4}}>Register New Asset</h1>
      <p className="text-lt text-sm" style={{marginBottom:24}}>Start by uploading a photo — AI will suggest asset details automatically.</p>

      {/* Step indicator */}
      <div style={{display:'flex',gap:0,marginBottom:28}}>
        {steps.map((s,i)=>(
          <React.Fragment key={s}>
            <div style={{display:'flex',alignItems:'center',gap:8,cursor:i+1<step?'pointer':'default'}} onClick={()=>i+1<step&&setStep(i+1)}>
              <div style={{width:28,height:28,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',fontSize:12,fontWeight:700,flexShrink:0,background:step===i+1?'var(--navy)':step>i+1?'var(--green)':'var(--border)',color:step>i?'#fff':'var(--slate)'}}>{step>i+1?'✓':i+1}</div>
              <span style={{fontSize:12,fontWeight:step===i+1?600:400,color:step===i+1?'var(--navy)':'var(--text-lt)'}}>{s}</span>
            </div>
            {i<steps.length-1&&<div style={{flex:1,height:1,background:'var(--border)',alignSelf:'center',margin:'0 8px'}}/>}
          </React.Fragment>
        ))}
      </div>

      {error && <Alert style={{marginBottom:16}}>{error}</Alert>}

      <div className="card">

        {/* ── STEP 1: Photo and AI ── */}
        {step===1&&(
          <div>
            <h3 style={{marginBottom:8}}>Upload Asset Photo</h3>
            <p className="text-lt text-sm" style={{marginBottom:20}}>
              Upload a clear photo of the asset. AI will automatically identify the category, manufacturer, model, condition and description. You can review and correct any suggestions before saving.
            </p>

            {photoPreview ? (
              <div style={{marginBottom:20}}>
                <img src={photoPreview} alt="Asset preview" style={{maxWidth:'100%',maxHeight:300,borderRadius:'var(--radius)',border:'1px solid var(--border)',objectFit:'cover',display:'block',marginBottom:12}}/>
                <div style={{display:'flex',gap:8}}>
                  <button className="btn-secondary btn-sm" onClick={()=>{setPhotoFile(null);setPhotoPreview(null);setPhotoError('');}}>Remove Photo</button>
                  <button className="btn-secondary btn-sm" onClick={()=>fileRef.current?.click()}>Change Photo</button>
                </div>
              </div>
            ) : (
              <label style={{display:'block',border:'2px dashed var(--border)',borderRadius:'var(--radius-lg)',padding:'48px 20px',textAlign:'center',cursor:'pointer',color:'var(--text-lt)',marginBottom:20}}>
                <div style={{fontSize:40,marginBottom:12}}>📷</div>
                <div style={{fontWeight:600,marginBottom:4,fontSize:15}}>Click to upload asset photograph</div>
                <div className="text-sm">JPEG or PNG — recommended for AI identification</div>
                <input ref={fileRef} type="file" accept="image/jpeg,image/png" style={{display:'none'}} onChange={handlePhotoSelect}/>
              </label>
            )}

            {photoError && <Alert type="info" style={{marginBottom:12}}>{photoError}</Alert>}

            <div style={{display:'flex',gap:10,justifyContent:'space-between',marginTop:8,paddingTop:16,borderTop:'1px solid var(--border)'}}>
              <button className="btn-secondary" onClick={()=>navigate('/assets')}>Cancel</button>
              <div style={{display:'flex',gap:10}}>
                <button className="btn-secondary" onClick={skipPhoto}>Skip — Enter Manually</button>
                <button className="btn-primary" onClick={handleAnalyze} disabled={analyzing}>
                  {analyzing ? '🔄 Analysing photo…' : photoFile ? '🔍 Analyse Photo & Continue' : 'Continue Without Photo'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── STEP 2: Details (pre-filled by AI) ── */}
        {step===2&&(
          <div>
            {aiStatus==='success'&&(
              <Alert type="info" style={{marginBottom:16}}>
                ✅ AI identified this asset. Fields have been pre-filled from the photo analysis. Review and correct any information before continuing.
              </Alert>
            )}
            {aiStatus==='manual'&&(
              <Alert type="info" style={{marginBottom:16}}>
                AI could not identify this asset from the photograph. Please enter the asset details manually.
              </Alert>
            )}
            {aiStatus==='skipped'&&(
              <Alert type="info" style={{marginBottom:16}}>
                No photo uploaded. Enter all asset details manually.
              </Alert>
            )}

            <div className="form-row">
              <Field label="Asset Name" required error={fieldErrors.name}><input value={form.name} onChange={e=>set('name',e.target.value)} placeholder="e.g. Dell Latitude 5540"/></Field>
              <Field label="Category"><select value={form.category} onChange={e=>set('category',e.target.value)}>{CATEGORIES.map(c=><option key={c}>{c}</option>)}</select></Field>
            </div>
            <div className="form-row">
              <Field label="Manufacturer"><input value={form.manufacturer} onChange={e=>set('manufacturer',e.target.value)}/></Field>
              <Field label="Model"><input value={form.model} onChange={e=>set('model',e.target.value)}/></Field>
            </div>
            <div className="form-row">
              <Field label="Serial Number"><input value={form.serial_number} onChange={e=>set('serial_number',e.target.value)}/></Field>
              <Field label="Asset Tag"><input value={form.asset_tag} onChange={e=>set('asset_tag',e.target.value)}/></Field>
            </div>
            <Field label="Description"><textarea value={form.description} onChange={e=>set('description',e.target.value)} rows={3} placeholder="Describe the asset"/></Field>
            <div className="form-row">
              <Field label="Status"><select value={form.status} onChange={e=>set('status',e.target.value)}>{STATUSES.map(s=><option key={s}>{s}</option>)}</select></Field>
              <Field label="Condition"><select value={form.condition} onChange={e=>set('condition',e.target.value)}>{CONDITIONS.map(c=><option key={c}>{c}</option>)}</select></Field>
            </div>
            <div className="form-row">
              <Field label="Acquisition Date" required error={fieldErrors.acquired_date}><input type="date" value={form.acquired_date} onChange={e=>set('acquired_date',e.target.value)}/></Field>
              <Field label="In Service Date (Depreciation Start)" required error={fieldErrors.in_service_date}><input type="date" value={form.in_service_date} onChange={e=>set('in_service_date',e.target.value)}/></Field>
            </div>
          </div>
        )}

        {/* ── STEP 3: Financial ── */}
        {step===3&&(
          <div>
            <Alert type="info" style={{marginBottom:14}}>Depreciation starts from the In Service date using straight-line method and is calculated automatically.</Alert>
            <div className="form-row">
              <Field label="Purchase Value ($)" required error={fieldErrors.purchase_value}><input type="number" min="0" step="0.01" value={form.purchase_value} onChange={e=>set('purchase_value',e.target.value)}/></Field>
              <Field label="Purchase Date" required error={fieldErrors.purchase_date}><input type="date" value={form.purchase_date} onChange={e=>set('purchase_date',e.target.value)}/></Field>
            </div>
            <div className="form-row">
              <Field label="Salvage Value ($)" required error={fieldErrors.salvage_value}><input type="number" min="0" step="0.01" value={form.salvage_value} onChange={e=>set('salvage_value',e.target.value)}/></Field>
              <Field label="Useful Life (months)" required error={fieldErrors.useful_life_months}><input type="number" min="1" step="1" value={form.useful_life_months} onChange={e=>set('useful_life_months',e.target.value)} placeholder="e.g. 60 for 5 years"/></Field>
            </div>
            {estAnnual&&(
              <div style={{padding:14,background:'var(--surface)',borderRadius:'var(--radius)',border:'1px solid var(--border)',marginBottom:14}}>
                <div style={{fontSize:12,color:'var(--text-lt)',marginBottom:4}}>Estimated depreciation</div>
                <div style={{fontWeight:700,fontSize:'1.1rem',color:'var(--navy)'}}>${estMonthly}/month · ${estAnnual}/year</div>
              </div>
            )}
            <Field label="Warranty Expiration"><input type="date" value={form.warranty_expiration} onChange={e=>set('warranty_expiration',e.target.value)}/></Field>
          </div>
        )}

        {/* ── STEP 4: Location ── */}
        {step===4&&(
          <div>
            <div className="form-row">
              <Field label="Building"><input value={form.building} onChange={e=>set('building',e.target.value)}/></Field>
              <Field label="Floor"><input value={form.floor} onChange={e=>set('floor',e.target.value)}/></Field>
            </div>
            <div className="form-row">
              <Field label="Room"><input value={form.room} onChange={e=>set('room',e.target.value)}/></Field>
              <Field label="Environment"><select value={form.environment} onChange={e=>set('environment',e.target.value)}>{ENVIRONMENTS.map(e=><option key={e}>{e}</option>)}</select></Field>
            </div>
            <div className="form-row">
              <Field label="Assigned To"><input value={form.assigned_to} onChange={e=>set('assigned_to',e.target.value)}/></Field>
              <Field label="Assigned Department"><input value={form.assigned_department} onChange={e=>set('assigned_department',e.target.value)}/></Field>
            </div>
            <Field label="Usage Level"><select value={form.usage_level} onChange={e=>set('usage_level',e.target.value)}>{USAGE_LEVELS.map(u=><option key={u}>{u}</option>)}</select></Field>
          </div>
        )}

        {/* ── STEP 5: Confirm ── */}
        {step===5&&(
          <div>
            <h3 style={{marginBottom:16}}>Review and Confirm</h3>
            {photoPreview&&(
              <div style={{marginBottom:20}}>
                <div className="text-sm text-lt" style={{marginBottom:8}}>Asset Photo</div>
                <img src={photoPreview} alt="Asset" style={{maxWidth:240,borderRadius:'var(--radius)',border:'1px solid var(--border)'}}/>
              </div>
            )}
            {[
              {heading:'Asset Details', rows:[['Name',form.name],['Category',form.category],['Manufacturer',form.manufacturer||'—'],['Model',form.model||'—'],['Serial Number',form.serial_number||'—'],['Status',form.status],['Condition',form.condition],['Acquired',form.acquired_date],['In Service (Depreciation Start)',form.in_service_date]]},
              {heading:'Financial', rows:[['Purchase Value',`$${form.purchase_value}`],['Purchase Date',form.purchase_date],['Salvage Value',`$${form.salvage_value}`],['Useful Life',`${form.useful_life_months} months (${(parseInt(form.useful_life_months||0)/12).toFixed(1)} yrs)`],['Est. Monthly Depreciation',estMonthly?`$${estMonthly}`:'—'],['Est. Annual Depreciation',estAnnual?`$${estAnnual}`:'—']]},
              {heading:'Location', rows:[['Building',form.building||'—'],['Room',form.room||'—'],['Assigned To',form.assigned_to||'—'],['Department',form.assigned_department||'—']]},
            ].map(section=>(
              <div key={section.heading} style={{marginBottom:20}}>
                <h3 style={{fontSize:13,color:'var(--slate)',marginBottom:10}}>{section.heading}</h3>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'6px 24px'}}>
                  {section.rows.map(([label,val])=><div key={label} style={{display:'flex',gap:8,fontSize:13}}><span style={{color:'var(--text-lt)',minWidth:160}}>{label}</span><span style={{fontWeight:500}}>{val}</span></div>)}
                </div>
              </div>
            ))}
            <Alert type="info" style={{marginTop:16}}>Depreciation will be calculated automatically from the In Service date when this record is saved.</Alert>
          </div>
        )}

        {/* Navigation buttons */}
        {step>1&&(
          <div style={{display:'flex',justifyContent:'space-between',marginTop:20,paddingTop:16,borderTop:'1px solid var(--border)'}}>
            <button className="btn-secondary" onClick={()=>setStep(s=>s-1)} disabled={saving}>Back</button>
            {step<5
              ? <button className="btn-primary" onClick={()=>{setFieldErrors({});setStep(s=>s+1);}}>Continue</button>
              : <button className="btn-primary" onClick={handleSubmit} disabled={saving}>{saving?'Saving…':'Save Asset'}</button>
            }
          </div>
        )}
      </div>
    </div>
  );
}

function EditAsset() {
  const {id}=useParams(); const navigate=useNavigate();
  const [saving,setSaving]=useState(false); const [fetching,setFetching]=useState(true);
  const [error,setError]=useState(''); const [tab,setTab]=useState('profile');
  const [form,setForm]=useState({}); const [aiPrepopulated,setAiPrepopulated]=useState(false);
  const [aiRejected,setAiRejected]=useState(false);

  useEffect(()=>{(async()=>{try{
    const records=await api.getAsset(id); const arr=Array.isArray(records)?records:[];
    const p=arr.find(r=>r.record_type==='PROFILE')||{};
    const f=arr.find(r=>r.record_type==='FINANCIALS')||{};
    const s=arr.find(r=>r.record_type==='STATUS')||{};
    const l=arr.filter(r=>r.record_type?.startsWith('LOCATION#')).sort((a,b)=>b.event_date?.localeCompare(a.event_date))[0]||{};
    const ns=v=>v==='NOT-SET'||v===null?'':(v||'');
    const baseForm={
      name:p.name||'',description:p.description||'',category:p.category||'IT Equipment',
      manufacturer:p.manufacturer||'',model:p.model||'',serial_number:p.serial_number||'',asset_tag:p.asset_tag||'',
      purchase_value:f.purchase_value||'',salvage_value:f.salvage_value||'',
      useful_life_months:f.useful_life_months||(f.useful_life_years?Math.round(f.useful_life_years*12):''),
      warranty_expiration:ns(f.warranty_expiration),total_repair_cost:f.total_repair_cost||0,number_of_repairs:f.number_of_repairs||0,
      status:s.status||'Available',usage_level:s.usage_level||'Daily',environment:s.environment||'Indoor',
      checked_out_to:ns(s.checked_out_to),expected_return_date:ns(s.expected_return_date),
      damage_description:ns(s.damage_description),theft_report_number:ns(s.theft_report_number),
      retirement_date:ns(s.retirement_date),retirement_reason:ns(s.retirement_reason),
      building:l.building||'',floor:l.floor||'',room:l.room||'',condition:l.condition||'Good',
      assigned_to:ns(l.assigned_to),assigned_department:ns(l.assigned_department),
      last_cleaning_date:ns(l.last_cleaning_date),last_inspection_date:ns(l.last_inspection_date),next_inspection_date:ns(l.next_inspection_date),
    };
    const aiRaw=sessionStorage.getItem('aiSuggestions');
    if(aiRaw){
      const ai=JSON.parse(aiRaw); sessionStorage.removeItem('aiSuggestions'); setAiPrepopulated(true);
      setForm({...baseForm,
        ...(ai.category&&{category:ai.category}),
        ...(ai.condition&&{condition:ai.condition}),
        ...(ai.description&&{description:ai.description}),
        ...(ai.useful_life_months&&{useful_life_months:ai.useful_life_months}),
      });
    } else { setForm(baseForm); }
    const rejected=sessionStorage.getItem('aiRejected');
    if(rejected){sessionStorage.removeItem('aiRejected');setAiRejected(true);}
  }catch(e){setError(e.message);}finally{setFetching(false);}})();},[id]);

  const set=(k,v)=>setForm(p=>({...p,[k]:v}));

  async function save(){
    setSaving(true);setError('');
    try{
      const body={...form};
      ['assigned_to','assigned_department','checked_out_to','expected_return_date','damage_description',
       'theft_report_number','retirement_date','retirement_reason','last_cleaning_date',
       'last_inspection_date','next_inspection_date','warranty_expiration'].forEach(k=>{if(!body[k]) body[k]=null;});
      await api.updateAsset(id,body);
      navigate(`/assets/${id}`);
    }catch(e){setError(e.message);}
    finally{setSaving(false);}
  }

  if(fetching) return <Spinner/>;
  return (
    <div style={{maxWidth:760}}>
      <div style={{display:'flex',gap:12,alignItems:'center',marginBottom:24}}>
        <button className="btn-icon" onClick={()=>navigate(`/assets/${id}`)}>←</button>
        <h1>Edit Asset — <span className="mono" style={{fontSize:'1rem',color:'var(--text-lt)'}}>{id}</span></h1>
      </div>
      {error&&<Alert>{error}</Alert>}
      {aiRejected&&<Alert type="info" style={{marginBottom:16}}>AI could not identify this asset. Please enter the asset details manually.</Alert>}
      {aiPrepopulated&&<Alert type="info" style={{marginBottom:16}}>Form pre-populated with AI suggestions. Review and adjust before saving.</Alert>}
      <Tabs tabs={['profile','financial','status','location']} active={tab} onChange={setTab}/>
      <div className="card">
        {tab==='profile'&&<>
          <div className="form-row"><Field label="Name"><input value={form.name} onChange={e=>set('name',e.target.value)}/></Field><Field label="Category"><select value={form.category} onChange={e=>set('category',e.target.value)}>{CATEGORIES.map(c=><option key={c}>{c}</option>)}</select></Field></div>
          <div className="form-row"><Field label="Manufacturer"><input value={form.manufacturer} onChange={e=>set('manufacturer',e.target.value)}/></Field><Field label="Model"><input value={form.model} onChange={e=>set('model',e.target.value)}/></Field></div>
          <div className="form-row"><Field label="Serial Number"><input value={form.serial_number} onChange={e=>set('serial_number',e.target.value)}/></Field><Field label="Asset Tag"><input value={form.asset_tag} onChange={e=>set('asset_tag',e.target.value)}/></Field></div>
          <Field label="Description"><textarea value={form.description} onChange={e=>set('description',e.target.value)} rows={3}/></Field>
        </>}
        {tab==='financial'&&<>
          <Alert type="info" style={{marginBottom:16}}>Updating financial fields recalculates depreciation automatically from the In Service date.</Alert>
          <div className="form-row">
            <Field label="Purchase Value ($)"><input type="number" value={form.purchase_value} onChange={e=>set('purchase_value',e.target.value)}/></Field>
            <Field label="Salvage Value ($)"><input type="number" value={form.salvage_value} onChange={e=>set('salvage_value',e.target.value)}/></Field>
          </div>
          <div className="form-row">
            <Field label="Useful Life (months)"><input type="number" min="1" step="1" value={form.useful_life_months} onChange={e=>set('useful_life_months',e.target.value)} placeholder="e.g. 60 for 5 years"/></Field>
            <Field label="Warranty Expiration"><input type="date" value={form.warranty_expiration} onChange={e=>set('warranty_expiration',e.target.value)}/></Field>
          </div>
          <div className="form-row">
            <Field label="Number of Repairs"><input type="number" min="0" value={form.number_of_repairs} onChange={e=>set('number_of_repairs',e.target.value)}/></Field>
            <Field label="Total Repair Cost ($)"><input type="number" min="0" step="0.01" value={form.total_repair_cost} onChange={e=>set('total_repair_cost',e.target.value)}/></Field>
          </div>
        </>}
        {tab==='status'&&<>
          <div className="form-row">
            <Field label="Status"><select value={form.status} onChange={e=>set('status',e.target.value)}>{STATUSES.map(s=><option key={s}>{s}</option>)}</select></Field>
            <Field label="Usage Level"><select value={form.usage_level} onChange={e=>set('usage_level',e.target.value)}>{USAGE_LEVELS.map(u=><option key={u}>{u}</option>)}</select></Field>
          </div>
          <Field label="Environment"><select value={form.environment} onChange={e=>set('environment',e.target.value)}>{ENVIRONMENTS.map(e=><option key={e}>{e}</option>)}</select></Field>
          {form.status==='Checked Out'&&<div className="form-row"><Field label="Checked Out To"><input value={form.checked_out_to} onChange={e=>set('checked_out_to',e.target.value)}/></Field><Field label="Expected Return"><input type="date" value={form.expected_return_date} onChange={e=>set('expected_return_date',e.target.value)}/></Field></div>}
          {form.status==='Damaged'&&<Field label="Damage Description"><textarea value={form.damage_description} onChange={e=>set('damage_description',e.target.value)} rows={2}/></Field>}
          {form.status==='Stolen'&&<Field label="Theft Report Number"><input value={form.theft_report_number} onChange={e=>set('theft_report_number',e.target.value)}/></Field>}
          {form.status==='Retired'&&<div className="form-row"><Field label="Retirement Date"><input type="date" value={form.retirement_date} onChange={e=>set('retirement_date',e.target.value)}/></Field><Field label="Retirement Reason"><input value={form.retirement_reason} onChange={e=>set('retirement_reason',e.target.value)}/></Field></div>}
        </>}
        {tab==='location'&&<>
          <div className="form-row"><Field label="Building"><input value={form.building} onChange={e=>set('building',e.target.value)}/></Field><Field label="Floor"><input value={form.floor} onChange={e=>set('floor',e.target.value)}/></Field></div>
          <div className="form-row"><Field label="Room"><input value={form.room} onChange={e=>set('room',e.target.value)}/></Field><Field label="Condition"><select value={form.condition} onChange={e=>set('condition',e.target.value)}>{CONDITIONS.map(c=><option key={c}>{c}</option>)}</select></Field></div>
          <div className="form-row"><Field label="Assigned To"><input value={form.assigned_to} onChange={e=>set('assigned_to',e.target.value)}/></Field><Field label="Department"><input value={form.assigned_department} onChange={e=>set('assigned_department',e.target.value)}/></Field></div>
          <div className="form-row"><Field label="Last Cleaned"><input type="date" value={form.last_cleaning_date} onChange={e=>set('last_cleaning_date',e.target.value)}/></Field><Field label="Last Inspected"><input type="date" value={form.last_inspection_date} onChange={e=>set('last_inspection_date',e.target.value)}/></Field></div>
          <Field label="Next Inspection"><input type="date" value={form.next_inspection_date} onChange={e=>set('next_inspection_date',e.target.value)}/></Field>
        </>}
        <div style={{display:'flex',justifyContent:'flex-end',gap:10,marginTop:20,paddingTop:16,borderTop:'1px solid var(--border)'}}>
          <button className="btn-secondary" onClick={()=>navigate(`/assets/${id}`)} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving}>{saving?'Saving…':'Save Changes'}</button>
        </div>
      </div>
    </div>
  );
}

function LogMaintenance() {
  const {id}=useParams(); const navigate=useNavigate();
  const [saving,setSaving]=useState(false); const [error,setError]=useState('');
  const [fieldErrors,setFieldErrors]=useState({});
  const [form,setForm]=useState({maintenance_type:'Scheduled',performed_date:new Date().toISOString().slice(0,10),cost:'',next_due_date:'',condition_after_service:'',notes:''});
  const set=(k,v)=>setForm(p=>({...p,[k]:v}));
  async function save(){
    const errs={};
    if(!form.maintenance_type) errs.maintenance_type='Maintenance type is required';
    if(!form.performed_date)   errs.performed_date='Performed date is required';
    if(Object.keys(errs).length){setFieldErrors(errs);return;}
    setSaving(true);setError('');setFieldErrors({});
    try{await api.addMaintenance(id,{...form,cost:parseFloat(form.cost)||0});navigate(`/assets/${id}`);}
    catch(e){setError(e.message);}
    finally{setSaving(false);}
  }
  return (
    <div style={{maxWidth:580}}>
      <div style={{display:'flex',gap:12,alignItems:'center',marginBottom:24}}>
        <button className="btn-icon" onClick={()=>navigate(`/assets/${id}`)}>←</button>
        <div><h1 style={{marginBottom:2}}>Log Maintenance</h1><div className="text-lt text-sm mono">{id}</div></div>
      </div>
      {error&&<Alert>{error}</Alert>}
      <div className="card">
        <div className="form-row">
          <Field label="Maintenance Type" required error={fieldErrors.maintenance_type}><select value={form.maintenance_type} onChange={e=>set('maintenance_type',e.target.value)}>{MAINT_TYPES.map(t=><option key={t}>{t}</option>)}</select></Field>
          <Field label="Performed Date" required error={fieldErrors.performed_date}><input type="date" value={form.performed_date} onChange={e=>set('performed_date',e.target.value)}/></Field>
        </div>
        <div className="form-row">
          <Field label="Cost ($)"><input type="number" min="0" step="0.01" value={form.cost} onChange={e=>set('cost',e.target.value)} placeholder="0.00"/></Field>
          <Field label="Next Due Date"><input type="date" value={form.next_due_date} onChange={e=>set('next_due_date',e.target.value)}/></Field>
        </div>
        <Field label="Condition After Service">
          <select value={form.condition_after_service} onChange={e=>set('condition_after_service',e.target.value)}>
            <option value="">— Not specified —</option>
            {CONDITIONS.map(c=><option key={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Notes"><textarea value={form.notes} onChange={e=>set('notes',e.target.value)} rows={3} placeholder="Details of work performed"/></Field>
        <Alert type="info" style={{marginBottom:12}}>Performed by will be recorded automatically from your login.</Alert>
        <div style={{display:'flex',justifyContent:'flex-end',gap:10,marginTop:8}}>
          <button className="btn-secondary" onClick={()=>navigate(`/assets/${id}`)}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving}>{saving?'Saving…':'Save Maintenance Record'}</button>
        </div>
      </div>
    </div>
  );
}

function Reports() {
  const [report,setReport]=useState(null); const [loading,setLoading]=useState(true); const [error,setError]=useState('');
  useEffect(()=>{api.getReports().then(setReport).catch(e=>setError(e.message)).finally(()=>setLoading(false));},[]);
  if(loading) return <Spinner/>;
  if(error)   return <Alert>{error}</Alert>;
  if(!report) return null;
  return (
    <div>
      <div style={{marginBottom:24}}><h1 style={{marginBottom:4}}>Asset Reports</h1><p className="text-lt text-sm">Generated {fmtDate(report.generated_at)}</p></div>
      <div className="stat-grid" style={{marginBottom:24}}>
        <StatCard label="Total Assets"        value={report.total_assets}                     sub="registered assets"/>
        <StatCard label="Total Book Value"    value={fmtCurrency(report.total_book_value)}    sub="current depreciated value"/>
        <StatCard label="Total Purchase Cost" value={fmtCurrency(report.total_purchase_cost)} sub="original investment"/>
        <StatCard label="Total Depreciation"  value={fmtCurrency(report.total_depreciation)}  sub="accumulated to date"/>
        <StatCard label="Total Repair Cost"   value={fmtCurrency(report.total_repair_cost)}   sub="cumulative repairs"/>
      </div>
      {report.by_category&&(
        <Card title="Breakdown by Category">
          <div className="table-wrap"><table>
            <thead><tr><th>Category</th><th>Count</th></tr></thead>
            <tbody>{Object.entries(report.by_category).sort((a,b)=>b[1]-a[1]).map(([cat,count])=>(
              <tr key={cat}><td style={{fontWeight:500}}>{cat}</td><td>{count}</td></tr>
            ))}</tbody>
          </table></div>
        </Card>
      )}
    </div>
  );
}

function RequireAuth({children}) {
  const {user,loading}=useAuth();
  if(loading) return <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center'}}><div className="spinner"/></div>;
  if(!user)   return <Navigate to="/login" replace/>;
  return children;
}
function RequirePerm({perm,children}) {
  const {can}=useAuth();
  if(!can(perm)) return <div style={{padding:40,textAlign:'center'}}><h2 style={{color:'var(--red)',marginBottom:8}}>Access Denied</h2><p className="text-lt">You do not have permission to view this page.</p></div>;
  return children;
}

export default function App() {
  return (
    <Authenticator.Provider>
      <Routes>
        <Route path="/login" element={<Authenticator hideSignUp>{()=><Navigate to="/" replace/>}</Authenticator>}/>
        <Route path="/*" element={
          <RequireAuth>
            <Layout>
              <Routes>
                <Route path="/"                       element={<Dashboard/>}/>
                <Route path="/assets"                 element={<AssetList/>}/>
                <Route path="/assets/:id"             element={<AssetDetail/>}/>
                <Route path="/assets/:id/edit"        element={<RequirePerm perm="update"><EditAsset/></RequirePerm>}/>
                <Route path="/assets/:id/maintenance" element={<RequirePerm perm="update"><LogMaintenance/></RequirePerm>}/>
                <Route path="/register"               element={<RequirePerm perm="create"><RegisterAsset/></RequirePerm>}/>
                <Route path="/reports"                element={<RequirePerm perm="reports"><Reports/></RequirePerm>}/>
                <Route path="*" element={<div style={{padding:40,textAlign:'center'}}><h2>Page not found</h2></div>}/>
              </Routes>
            </Layout>
          </RequireAuth>
        }/>
      </Routes>
    </Authenticator.Provider>
  );
}
