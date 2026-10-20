// index.html のロジックのテスト（依存なし。node tests/run.js で実行）
//  - <script> の構文チェック
//  - 古い iOS Safari で構文エラーになる正規表現の後読みを使っていないか
//  - 曲名の自動判定（guessSongName）：手作りの例は全問、実際の YouTube タイトルは基準点以上
//  - 回答の表記ゆれ吸収（normalize）
//  - 4択の選択肢（makeOptions）
//  - 今日のチャレンジの乱数（seededRand）：同じ日付なら同じ並び
const fs=require('fs'), path=require('path'), vm=require('vm'), cp=require('child_process'), os=require('os');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
let failed=0;
const ok=(cond,msg)=>{ console.log((cond?'  ok   ':'  FAIL ')+msg); if(!cond) failed++; };

// 1) 構文チェック
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n;\n');
const tmp=path.join(os.tmpdir(),'iq_check_'+process.pid+'.js'); fs.writeFileSync(tmp, scripts);
let syntaxOk=true; try{ cp.execFileSync(process.execPath,['--check',tmp],{stdio:'pipe'}); }catch(e){ syntaxOk=false; console.log(String(e.stderr||e)); }
fs.unlinkSync(tmp);
ok(syntaxOk,'<script> の構文');
ok(!/\(\?<[=!]/.test(scripts),'正規表現の後読みを使っていない（iOS 16.4 未満で動かなくなるため）');

// 2) テスト対象の関数を取り出す（曲名判定ブロックと、normalize・4択の関数）
const pick=(start,end)=>{ const s=scripts.indexOf(start), e=scripts.indexOf(end,s); if(s<0||e<0) throw new Error('見つからない: '+start); return scripts.slice(s,e); };
const fnSrc=(name)=>{ const m=new RegExp('function '+name+'\\([^)]*\\)\\{').exec(scripts); if(!m) throw new Error('関数が見つからない: '+name);
  let i=m.index+m[0].length, depth=1; while(depth>0 && i<scripts.length){ const c=scripts[i++]; if(c==='{') depth++; else if(c==='}') depth--; } return scripts.slice(m.index,i); };
const code=[
  pick('// ===== 曲名の自動判定（YouTubeの動画タイトル','function extractPlaylistId'),
  fnSrc('normalize'), fnSrc('makeOptions'), fnSrc('seededRand'),
  'globalThis.__t={ guessSongName, normalize, makeOptions, seededRand };'
].join('\n');
const ctx={}; vm.createContext(ctx); vm.runInContext(code, ctx);
const { guessSongName, normalize, makeOptions, seededRand }=ctx.__t;

// 3) 曲名の自動判定
const readTsv=f=>fs.readFileSync(path.join(__dirname,f),'utf8').split(/\r?\n/).filter(Boolean).map(l=>l.split('\t'));
const run=(rows)=>{ let n=0; const ng=[]; for(const [t,c,exp] of rows){ const r=guessSongName(t,c); if(r.song===exp) n++; else ng.push(`${JSON.stringify(r.song)} ≠ ${JSON.stringify(exp)}  ← ${t}`); } return { n, ng }; };
const basic=readTsv('song-name-basic.tsv'), real=readTsv('song-name-real.tsv');
const b=run(basic), r=run(real);
ok(b.n===basic.length, `曲名判定（手作りの例）${b.n}/${basic.length}`); if(b.n<basic.length) b.ng.forEach(x=>console.log('         '+x));
const REAL_MIN=128;   // 2026-10-21 時点の正解数。下がったら判定ルールの変更を見直す
ok(r.n>=REAL_MIN, `曲名判定（実際のタイトル）${r.n}/${real.length}（基準 ${REAL_MIN} 以上）`);
if(r.n<REAL_MIN || process.argv.includes('-v')) r.ng.forEach(x=>console.log('         '+x));
const ak=guessSongName('ヒグチアイ / 悪魔の子 (アニメスペシャルVer.) | Ai Higuchi “Akuma no Ko” Anime Special Ver.','ヒグチアイ');
ok(ak.song==='悪魔の子' && ak.alts.includes('Akuma no Ko'), '別解（英語・ローマ字表記）を拾う');

// 4) 表記ゆれ
for(const [a,c] of [['てすと５','テスト5'],['ﾃｽﾄ','テスト'],['ＬＥＭＯＮ','Lemon'],['ゔぁんぷ','ヴァンプ'],['Ｕ.Ｓ.Ａ.','U.S.A.'],['夜に駆ける！','夜に駆ける']])
  ok(normalize(a)===normalize(c), `normalize: 「${a}」＝「${c}」`);
ok(normalize('アイドル')!==normalize('アイロン'), 'normalize: 違う曲名は一致しない');

// 5) 4択
const opts=makeOptions('夜に駆ける',['夜に駆ける','よるにかける','アイドル','群青','怪物','ハルジオン']);
ok(opts.length===4 && opts.includes('夜に駆ける'), '4択：正解を含む4つ');
ok(new Set(opts.map(normalize)).size===4, '4択：同じ表記の選択肢を重ねない');
ok(makeOptions('A',['A']).length===1, '4択：候補が足りなければ少なくなる（画面側で入力欄に切り替える）');

// 6) 今日のチャレンジ
const seq=s=>{ const r=seededRand(s); return Array.from({length:8},()=>r()); };
ok(JSON.stringify(seq('iq-daily:2026-10-21'))===JSON.stringify(seq('iq-daily:2026-10-21')), '今日のチャレンジ：同じ日付なら同じ乱数列（全員同じ曲）');
ok(JSON.stringify(seq('iq-daily:2026-10-21'))!==JSON.stringify(seq('iq-daily:2026-10-22')), '今日のチャレンジ：日付が違えば別の乱数列');
ok(seq('x').every(v=>v>=0 && v<1), '今日のチャレンジ：乱数は 0 以上 1 未満');

console.log(failed?`\n${failed} 件失敗`:'\nすべて成功');
process.exit(failed?1:0);
