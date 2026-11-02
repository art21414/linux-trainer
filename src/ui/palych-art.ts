// Рисунок Палыча (inline SVG). Цвета — только классами/переменными из styles/mascot.css (--pk-*).
// viewBox 240x300: бюст по пояс. Слои сзади вперёд: тело, шея, руки, голова, лицо-детали, эффекты.
let uid = 0;

export function palychSvg(): string {
  const u = `pk${++uid}`;
  return `
<svg class="palych m-idle" viewBox="0 0 240 300" aria-hidden="true">
  <defs>
    <pattern id="${u}-d" width="3" height="3" patternUnits="userSpaceOnUse"><rect x="0" y="0" width="1.2" height="1.2" class="pk-ink-f"/></pattern>
    <pattern id="${u}-s" width="3" height="3" patternUnits="userSpaceOnUse"><rect x="0" y="0" width="1" height="1" fill="#6f675c"/><rect x="1.5" y="1.5" width="1" height="1" fill="#6f675c"/></pattern>
    <clipPath id="${u}-f"><path d="M120,40 C98,40 86,56 85,80 C85,96 88,108 95,118 C101,128 109,134 120,134 C131,134 139,128 145,118 C152,108 155,96 155,80 C154,56 142,40 120,40 Z"/></clipPath>
    <clipPath id="${u}-el"><ellipse cx="103" cy="82" rx="8" ry="7"/></clipPath>
    <clipPath id="${u}-er"><ellipse cx="137" cy="82" rx="8" ry="7"/></clipPath>
    <clipPath id="${u}-tee"><path d="M101,146 C108,160 132,160 139,146 L150,190 C164,226 166,266 150,300 L90,300 C74,266 76,226 90,190 Z"/></clipPath>
  </defs>

  <g class="p-fx">
  <!-- ===== ТЕЛО ===== -->
  <g class="p-body">
    <!-- кардиган: спинка и полы -->
    <path class="cds ol" d="M56,176 C54,156 72,148 98,144 L142,144 C168,148 186,156 184,176 L192,236 C196,266 190,288 186,300 L54,300 C50,288 44,266 48,236 Z"/>
    <path class="cd ol" d="M98,146 C80,150 58,156 57,176 L49,236 C46,266 52,288 56,300 L88,300 C84,270 84,236 90,200 C92,176 96,160 98,146 Z"/>
    <path class="cd ol" d="M142,146 C160,150 182,156 183,176 L191,236 C194,266 188,288 184,300 L152,300 C156,270 156,236 150,200 C148,176 144,160 142,146 Z"/>
    <!-- вязка: ребристая кромка полов -->
    <path class="cdh-s" d="M93,182 L91,196 M92,206 L89,222 M90,230 L87,246 M89,254 L87,270 M147,182 L149,196 M148,206 L151,222 M150,230 L153,246 M151,254 L153,270" fill="none" stroke-width="2" stroke-linecap="round"/>
    <path class="cds-s" d="M62,196 l4,4 M70,214 l4,4 M60,236 l4,4 M66,262 l4,4 M172,196 l-4,4 M176,224 l-4,4 M178,252 l-4,4" fill="none" stroke-width="1.6" stroke-linecap="round"/>
    <!-- майка, пузо -->
    <path class="tee ol" d="M101,146 C108,160 132,160 139,146 L150,190 C164,226 166,266 150,300 L90,300 C74,266 76,226 90,190 Z"/>
    <g clip-path="url(#${u}-tee)">
      <path class="tees" d="M90,236 C96,262 112,274 124,276 C138,276 154,262 160,236 C162,262 150,292 120,296 C92,292 80,262 90,236 Z" opacity=".75"/>
      <rect x="70" y="236" width="100" height="64" fill="url(#${u}-d)" opacity=".16"/>
      <path class="tees-s" d="M88,206 q10,6 18,2 M152,208 q-10,6 -18,2 M92,238 q8,4 14,0 M148,240 q-8,4 -14,0" fill="none" stroke-width="1.6" stroke-linecap="round"/>
      <circle cx="140" cy="262" r="8" fill="#7b5233" opacity=".5"/>
      <circle cx="140" cy="262" r="8" fill="none" stroke="#5a3a22" stroke-width="1.4" opacity=".7"/>
      <path id="${u}-arc" d="M88,212 Q120,222 152,212" fill="none"/>
      <text class="tee-text" font-size="20" text-anchor="middle"><textPath href="#${u}-arc" startOffset="50%">RTFM</textPath></text>
    </g>
    <path class="ol" d="M101,146 C108,160 132,160 139,146" fill="none"/>
    <path class="tees-s" d="M104,149 C110,160 130,160 136,149" fill="none" stroke-width="3" stroke-linecap="round"/>
    <!-- карман с отвёрткой и ручкой -->
    <path class="cds ol" d="M160,244 L186,244 L184,278 L162,278 Z"/>
    <path class="cdh-s" d="M162,248 H184" stroke-width="1.5" fill="none"/>
    <rect x="165" y="222" width="7" height="22" rx="2" class="acc ol"/>
    <path class="ol" d="M168.5,222 V214" stroke-width="2" fill="none"/>
    <rect x="175" y="228" width="3" height="16" class="pen ol" stroke-width="1.2"/>
    <!-- бейдж-прищепка на правой поле -->
    <g class="p-badge" transform="translate(10 8) rotate(7 160 200)">
      <rect x="158" y="176" width="5" height="8" rx="1" class="ink-f"/>
      <rect x="148" y="182" width="26" height="36" rx="2" class="badge ol" stroke-width="2"/>
      <rect x="150" y="184" width="22" height="8" class="acc"/>
      <text x="161" y="190.5" font-size="6.5" font-weight="600" text-anchor="middle" class="pk-mono ink-f">UID 0</text>
      <rect x="152" y="195" width="10" height="12" class="sk ol" stroke-width="1.2"/>
      <path class="ink-s" d="M165,197 h4 M165,201 h4 M165,205 h3 M152,212 h18" stroke-width="1.4" fill="none"/>
    </g>
    <!-- воротник кардигана -->
    <path class="cd ol" d="M98,146 C92,142 86,140 82,146 L96,176 L102,150 Z"/>
    <path class="cd ol" d="M142,146 C148,142 154,140 158,146 L144,176 L138,150 Z"/>
  </g>

  <!-- ===== ШЕЯ ===== -->
  <path class="sk ol" d="M103,114 L103,148 C112,158 128,158 137,148 L137,114 Z"/>
  <path class="sks" d="M103,118 C112,138 128,138 137,118 L137,114 L103,114 Z" opacity=".9"/>
  <path class="sks" d="M122,132 L137,146 L137,114 L122,114 Z" opacity=".35"/>
  <path class="ink-s" d="M104,138 q16,8 32,0" stroke-width="1.4" fill="none" opacity=".4"/>

  <!-- ===== ПРАВАЯ РУКА (сигарета) ===== -->
  <g class="p-arm-r">
    <path class="ol" d="M172,168 Q214,186 206,232 Q204,204 199,180" stroke-width="31" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <path class="cd-s" d="M172,168 Q214,186 206,232 Q204,204 199,180" stroke-width="25" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <ellipse cx="206" cy="212" rx="7" ry="9" class="leather ol" stroke-width="1.4" transform="rotate(8 206 212)"/>
    <path class="cdh-s" d="M184,172 q16,8 20,22" stroke-width="2" fill="none" opacity=".6" stroke-linecap="round"/>
    <path class="ink-s" d="M190,176 Q198,184 206,182" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    <g class="p-smoke" fill="none" stroke-linecap="round">
      <path class="k1" d="M221,122 q7,-9 0,-18 q-7,-9 0,-18"/>
      <path class="k2" d="M223,120 q-7,-9 0,-18 q7,-9 0,-18"/>
    </g>
    <path class="ol" d="M198,160 L223,128" stroke-width="7.5" stroke-linecap="round"/>
    <path class="cig" d="M198,160 L223,128" stroke-width="4.5" stroke-linecap="round"/>
    <path class="acc-s" d="M198,160 L204,152" stroke-width="4.5" stroke-linecap="round"/>
    <circle class="p-tip" cx="224" cy="127" r="3.2" fill="#ff6a2a"/>
    <path class="ol sk" d="M193,176 C186,170 190,158 198,158 C206,158 208,166 204,172 C202,178 196,180 193,176 Z" stroke-width="2"/>
    <path class="ink-s" d="M196,162 q4,3 9,0 M195,168 q5,3 10,0" stroke-width="1.2" fill="none" opacity=".6" stroke-linecap="round"/>
    <path class="nic" d="M198,158 C202,152 206,152 208,156" stroke-width="3" fill="none" stroke-linecap="round" opacity=".55"/>
  </g>

  <!-- ===== ГОЛОВА ===== -->
  <g class="p-head"><g class="p-head-i">
    <!-- уши -->
    <ellipse cx="85" cy="88" rx="6.5" ry="10" class="sk ol"/><path class="sks-s" d="M84,82 q-3,6 0,12" stroke-width="2" fill="none" stroke-linecap="round"/>
    <ellipse cx="155" cy="88" rx="6.5" ry="10" class="sk ol"/><path class="sks-s" d="M156,82 q3,6 0,12" stroke-width="2" fill="none" stroke-linecap="round"/>
    <path class="hr-s" d="M81,90 l-2,3 M80,86 l-3,1 M159,90 l2,3 M160,86 l3,1" stroke-width="1.4" stroke-linecap="round"/>
    <!-- седые клочки по бокам -->
    <g class="p-tufts">
      <path class="hr ol t-l" d="M88,90 C79,78 80,60 92,48 C92,56 96,58 98,60 C95,68 97,76 94,86 Z" stroke-width="1.8"/>
      <path class="hr ol t-r" d="M152,90 C161,78 160,60 148,48 C148,56 144,58 142,60 C145,68 143,76 146,86 Z" stroke-width="1.8"/>
    </g>
    <!-- лицо -->
    <path class="sk ol" d="M120,40 C98,40 86,56 85,80 C85,96 88,108 95,118 C101,128 109,134 120,134 C131,134 139,128 145,118 C152,108 155,96 155,80 C154,56 142,40 120,40 Z" stroke-width="2.4"/>
    <g clip-path="url(#${u}-f)">
      <path class="sks" d="M138,36 C152,50 160,64 160,84 C160,110 150,130 130,140 C144,124 148,104 146,80 C144,62 140,50 130,38 Z" opacity=".75"/>
      <path class="skh" d="M100,44 C108,38 124,38 132,44 C124,42 110,42 100,50 Z" opacity=".8"/>
      <ellipse cx="108" cy="52" rx="9" ry="4" class="skh" opacity=".6" transform="rotate(-20 108 52)"/>
      <rect x="82" y="100" width="76" height="40" fill="url(#${u}-s)" opacity=".55"/>
      <path class="sk" d="M96,100 C100,106 106,108 112,108 L128,108 C134,108 140,106 144,100 C140,98 100,98 96,100 Z" opacity=".9"/>
      <ellipse class="p-flush" cx="97" cy="102" rx="8" ry="5" fill="#d9604c"/><ellipse class="p-flush" cx="143" cy="102" rx="8" ry="5" fill="#d9604c"/>
      <ellipse class="p-red" cx="120" cy="86" rx="40" ry="52" fill="#e5675b"/>
    </g>
    <!-- залысина: редкие волосины -->
    <path class="hr-s" d="M100,52 Q120,40 140,52 M98,57 Q120,44 142,57 M102,62 Q120,50 138,62" stroke-width="1.1" fill="none" opacity=".75" stroke-linecap="round"/>
    <!-- морщины -->
    <path class="sks-s" d="M100,60 Q120,55 140,60 M103,66 Q120,62 137,66" stroke-width="1.5" fill="none" stroke-linecap="round" opacity=".8"/>
    <path class="sks-s" d="M88,80 l-1,5 M89,86 l-1,5 M152,80 l1,5 M151,86 l1,5" stroke-width="1.3" fill="none" stroke-linecap="round"/>
    <path class="sks-s" d="M96,96 Q103,101 111,96 M129,96 Q137,101 144,96" stroke-width="2.4" fill="none" stroke-linecap="round" opacity=".9"/>
    <path class="sks-s" d="M109,103 Q104,112 106,122 M131,103 Q136,112 134,122" stroke-width="1.6" fill="none" stroke-linecap="round"/>
    <!-- нос -->
    <path class="nose ol" d="M120,82 C114,90 111,98 114,104 C117,109 123,109 126,104 C129,98 126,90 120,82 Z" stroke-width="1.8"/>
    <ellipse cx="118" cy="98" rx="2.5" ry="3" fill="#fff" opacity=".35"/>
    <path class="ink-s" d="M116,105 q1,1.5 2,0 M122,105 q1,1.5 2,0" stroke-width="1.2" fill="none" opacity=".7"/>

    <!-- глаза -->
    <g class="p-eyes">
      <g class="p-eye p-eye-l">
        <ellipse cx="103" cy="82" rx="8" ry="7" class="eye"/>
        <circle class="p-pupil" cx="103" cy="82.5" r="3.2" fill="#1d1712"/><circle class="p-pupil" cx="104.5" cy="81" r="1" fill="#fff"/>
        <g clip-path="url(#${u}-el)"><g class="p-lid"><rect x="93" y="74" width="20" height="16" class="sk"/><path class="ol" d="M93,90 H113" stroke-width="1.8" fill="none"/></g></g>
      </g>
      <g class="p-eye p-eye-r">
        <ellipse cx="137" cy="82" rx="8" ry="7" class="eye"/>
        <circle class="p-pupil" cx="137" cy="82.5" r="3.2" fill="#1d1712"/><circle class="p-pupil" cx="138.5" cy="81" r="1" fill="#fff"/>
        <g clip-path="url(#${u}-er)"><g class="p-lid"><rect x="127" y="74" width="20" height="16" class="sk"/><path class="ol" d="M127,90 H147" stroke-width="1.8" fill="none"/></g></g>
      </g>
    </g>
    <g class="p-happyeyes"><path class="ol" d="M95,86 Q103,76 111,86 M129,86 Q137,76 145,86" stroke-width="3" fill="none"/></g>
    <!-- мешки под глазами -->
    <path class="sks-s" d="M94,93 Q103,99 112,93 M128,93 Q137,99 146,93" stroke-width="1.6" fill="none" stroke-linecap="round" opacity=".9"/>

    <!-- очки: чёрная пластмасса 90-х, изолента на переносице -->
    <g class="p-glasses">
      <rect x="90" y="70" width="26" height="25" rx="5" class="lens"/>
      <rect x="124" y="70" width="26" height="25" rx="5" class="lens"/>
      <path d="M93,74 l8,-0 M127,74 l8,0" class="glint" stroke-width="2" stroke-linecap="round"/>
      <rect x="90" y="70" width="26" height="25" rx="5" fill="none" class="frame" stroke-width="3.6"/>
      <rect x="124" y="70" width="26" height="25" rx="5" fill="none" class="frame" stroke-width="3.6"/>
      <path class="frame" d="M116,77 Q120,73 124,77 M90,76 L84,74 M150,76 L156,74" fill="none" stroke-width="3" stroke-linecap="round"/>
      <rect x="116.5" y="73" width="7" height="8" class="tape ol" stroke-width="1" transform="rotate(-8 120 77)"/>
      <path class="ink-s" d="M117.5,75 l5,4 M122.5,75 l-5,4" stroke-width=".8" fill="none"/>
    </g>
    <!-- брови -->
    <path class="p-brow p-brow-l hr-s" d="M91,66 Q103,58 117,64" stroke-width="6" fill="none" stroke-linecap="round"/>
    <path class="p-brow p-brow-r hr-s" d="M123,64 Q137,58 149,66" stroke-width="6" fill="none" stroke-linecap="round"/>

    <!-- рот (под усами) -->
    <g class="p-mouth">
      <path class="mo mo-idle ol" d="M111,125 Q120,127 129,124" fill="none" stroke-width="2.2" stroke-linecap="round"/>
      <g class="mo mo-happy"><path class="mouthd ol" d="M108,121 Q120,140 132,121 Q120,126 108,121 Z" stroke-width="1.8"/><path class="teeth" d="M111,122 Q120,127 129,122 L128,125 Q120,129 112,125 Z"/></g>
      <path class="mo mo-angry ol" d="M110,131 Q120,121 130,131" fill="none" stroke-width="2.6" stroke-linecap="round"/>
      <ellipse class="mo mo-shock mouthd ol" cx="120" cy="127" rx="6" ry="8" stroke-width="1.8"/>
      <path class="mo mo-smug ol" d="M110,127 Q121,129 131,121" fill="none" stroke-width="2.4" stroke-linecap="round"/>
      <path class="mo mo-think ol" d="M112,128 L126,125" fill="none" stroke-width="2.4" stroke-linecap="round"/>
      <ellipse class="mo mo-sleep mouthd ol" cx="120" cy="126" rx="4.5" ry="3.5" stroke-width="1.6"/>
      <path class="mo mo-grim ol" d="M110,128 L114,124 L118,128 L122,124 L126,128 L130,124" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path class="mo mo-proud ol" d="M109,122 Q120,132 131,122" fill="none" stroke-width="2.6" stroke-linecap="round"/>
      <path class="mo mo-flat ol" d="M112,126.5 L128,126.5" fill="none" stroke-width="2.4" stroke-linecap="round"/>
    </g>
    <!-- усы -->
    <path class="p-must hr ol" d="M120,110 C112,105 100,107 96,115 C94,121 98,128 103,126 C102,122 106,118 112,118 C116,118 118,117 120,117 C122,117 124,118 128,118 C134,118 138,122 137,126 C142,128 146,121 144,115 C140,107 128,105 120,110 Z" stroke-width="1.8"/>
    <path class="hr-s2" d="M104,113 q6,0 12,3 M136,113 q-6,0 -12,3 M100,118 q2,4 4,6 M140,118 q-2,4 -4,6" stroke-width="1.2" fill="none" stroke-linecap="round"/>
    <path class="nic" d="M124,118 q8,3 12,7" stroke-width="2.4" fill="none" opacity=".5" stroke-linecap="round"/>
    <!-- щетина на подбородке -->
    <path class="hr-s2" d="M110,131 l1,1 M116,133 l1,1 M124,133 l1,1 M130,131 l1,1 M120,130 l1,1" stroke-width="1" stroke-linecap="round"/>

    <!-- эффекты вокруг головы -->
    <path class="p-vein" d="M140,48 l8,4 M144,44 l0,10 M140,52 l8,-4" stroke="#e5675b" stroke-width="2.6" stroke-linecap="round" fill="none"/>
    <path class="p-sweat" d="M160,60 C156,68 154,72 158,76 C162,79 166,75 164,70 C163,67 161,64 160,60 Z"/>
    <path class="p-sweat p-sweat2" d="M80,52 C77,58 75,61 78,64 C81,66 84,63 83,59 C82,57 81,55 80,52 Z"/>
    <g class="p-earsteam" fill="#ece5d3"><circle cx="76" cy="84" r="4.5"/><circle cx="70" cy="76" r="3.5"/><circle cx="164" cy="84" r="4.5"/><circle cx="170" cy="76" r="3.5"/></g>
    <g class="p-zzz pk-pixel" fill="#b3ac99"><text class="z1" x="160" y="52" font-size="14">z</text><text class="z2" x="170" y="38" font-size="18">z</text><text class="z3" x="182" y="20" font-size="22">Z</text></g>
    <g class="p-bang pk-pixel" fill="#f2a03d"><text x="166" y="42" font-size="34" font-weight="700">!</text></g>
    <g class="p-ques pk-pixel" fill="#f2a03d"><text x="162" y="44" font-size="32" font-weight="700">?</text></g>
    <g class="p-spark" fill="#f2a03d">
      <path class="sp1" d="M62,56 l2,-6 l2,6 l6,2 l-6,2 l-2,6 l-2,-6 l-6,-2 z"/>
      <path class="sp2" d="M176,40 l1.5,-5 l1.5,5 l5,1.5 l-5,1.5 l-1.5,5 l-1.5,-5 l-5,-1.5 z"/>
      <path class="sp3" d="M186,84 l1.5,-4 l1.5,4 l4,1.5 l-4,1.5 l-1.5,4 l-1.5,-4 l-4,-1.5 z"/>
    </g>
    <g class="p-exhale" fill="none" stroke-linecap="round"><path class="e1" d="M134,128 q10,-2 16,-10"/><path class="e2" d="M136,132 q12,0 20,-8"/></g>
  </g></g>

  <!-- ===== ЛЕВАЯ РУКА (кружка) — поверх головы, чтобы кружка закрывала лицо при глотке ===== -->
  <g class="p-arm-l">
    <path class="ol" d="M66,168 Q38,196 44,238 Q48,254 64,250" stroke-width="31" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <path class="cd-s" d="M66,168 Q38,196 44,238 Q48,254 64,250" stroke-width="25" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <ellipse cx="44" cy="222" rx="7" ry="9" class="leather ol" stroke-width="1.4" transform="rotate(-8 44 222)"/>
    <path class="cdh-s" d="M58,176 q-14,12 -14,30" stroke-width="2" fill="none" opacity=".6" stroke-linecap="round"/>
    <g class="p-mug">
      <path class="mugh ol" d="M70,232 C56,230 56,254 70,252" fill="none" stroke-width="5" stroke-linecap="round"/>
      <path class="mug" d="M70,232 C58,231 58,252 70,251" fill="none" stroke-width="2.2" stroke-linecap="round"/>
      <rect x="68" y="218" width="32" height="40" rx="4" class="mug ol"/>
      <rect x="70" y="248" width="28" height="8" rx="2" fill="#000" opacity=".12"/>
      <rect x="77" y="228" width="19" height="16" rx="1.5" class="screen ol" stroke-width="1.4"/>
      <text x="86.5" y="240" font-size="10" font-weight="700" text-anchor="middle" class="pk-mono" fill="#f2a03d">&gt;_</text>
      <ellipse cx="84" cy="218" rx="16" ry="3.6" class="coffee ol" stroke-width="1.6"/>
      <g class="p-steam" fill="none" stroke-linecap="round">
        <path class="s1" d="M76,212 q-4,-6 0,-12 q4,-6 0,-12"/><path class="s2" d="M84,212 q-4,-6 0,-12 q4,-6 0,-12"/><path class="s3" d="M92,212 q-4,-6 0,-12 q4,-6 0,-12"/>
      </g>
    </g>
    <path class="sk ol" d="M58,240 C55,232 60,225 69,225 L74,227 C77,233 77,244 74,252 C69,258 60,256 58,240 Z" stroke-width="2"/>
    <path class="ol" d="M64,234 H75 M64,241 H76 M65,248 H75" fill="none" stroke-width="1.6" stroke-linecap="round"/>
    <path class="sks-s" d="M60,244 q2,8 8,10" stroke-width="2" fill="none" stroke-linecap="round" opacity=".7"/>
  </g>

  <!-- ===== ФЕЙСПАЛМ: рука к лицу ===== -->
  <g class="p-arm-fp">
    <path class="ol" d="M174,170 Q216,160 190,116" stroke-width="31" fill="none" stroke-linecap="round"/>
    <path class="cd-s" d="M174,170 Q216,160 190,116" stroke-width="25" fill="none" stroke-linecap="round"/>
    <path class="ol" d="M190,116 Q168,96 140,92" stroke-width="20" fill="none" stroke-linecap="round"/>
    <path class="sk-s" d="M190,116 Q168,96 140,92" stroke-width="15" fill="none" stroke-linecap="round"/>
    <path class="sk ol" d="M148,102 C132,104 120,92 118,78 C124,70 140,68 150,76 C158,84 158,98 148,102 Z" stroke-width="2.2"/>
    <path class="ol" d="M124,80 C128,86 130,92 130,96 M132,76 C136,82 138,88 138,94 M141,76 C144,82 146,86 146,92" fill="none" stroke-width="1.6" stroke-linecap="round"/>
  </g>

  <!-- ===== ПЕЧАТАЕТ ===== -->
  <g class="p-type">
    <path class="ol" d="M66,170 Q30,226 88,272" stroke-width="31" fill="none" stroke-linecap="round"/><path class="cd-s" d="M66,170 Q30,226 88,272" stroke-width="25" fill="none" stroke-linecap="round"/>
    <path class="ol" d="M174,170 Q210,226 152,272" stroke-width="31" fill="none" stroke-linecap="round"/><path class="cd-s" d="M174,170 Q210,226 152,272" stroke-width="25" fill="none" stroke-linecap="round"/>
    <path class="kb ol" d="M58,284 L182,284 L192,300 L48,300 Z"/>
    <path class="ink-s" d="M62,290 H178 M56,295 H184 M72,284 l-6,16 M94,284 l-4,16 M116,284 l-2,16 M138,284 l2,16 M160,284 l4,16" stroke-width="1.2" fill="none" opacity=".55"/>
    <g class="hand-l"><ellipse cx="92" cy="276" rx="13" ry="8" class="sk ol" stroke-width="2"/><path class="ol" d="M84,278 v4 M90,279 v4 M96,279 v4 M102,278 v4" stroke-width="1.4" stroke-linecap="round"/></g>
    <g class="hand-r"><ellipse cx="148" cy="276" rx="13" ry="8" class="sk ol" stroke-width="2"/><path class="ol" d="M138,278 v4 M144,279 v4 M150,279 v4 M156,278 v4" stroke-width="1.4" stroke-linecap="round"/></g>
  </g>
  </g>
</svg>`;
}

/** Совместимость: готовая строка для одного экземпляра. */
export const PALYCH_SVG = palychSvg();
