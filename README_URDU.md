# Chaico Mobile — APK Kaise Banayein

Ye poora Android project hai (Capacitor se generate kiya gaya), jisme
aapki desktop app (items, POS/sales, udhar, expenses, reports) same features
ke saath web technology (HTML/JS) mein dobara bani hai, aur ek real
Android app (`.apk`) mein wrap ki gayi hai. Data device par hi local
SQLite (`.db`) format mein store hota hai — bilkul desktop wali file jaisa —
aur Settings screen se aap apni purani `chaico_data.db` backup **directly
import** kar sakte hain.

**Yahan (is sandbox) mein real `.apk` compile nahi ho sakti** kyunki
Android SDK aur Google ke build servers tak yahan network access nahi hai.
Neeche 2 tareeqe diye hain — Option A mein **kuch bhi install nahi karna**,
sirf browser chahiye.

---

## Option A (Recommended) — Kuch install kiye baghair, GitHub se

Isme koi bhi software (Android Studio waghera) install nahi karna, sab kuch
GitHub ke free servers par khud-ba-khud build ho jata hai. Sirf ek free
GitHub account chahiye.

1. https://github.com par free account banayein (agar nahi hai)
2. Login karke, right top corner par **"+"** → **"New repository"**
   - Naam kuch bhi rakh dein, jaise `chaico-app`
   - **"Create repository"** dabayein
3. Naye page par **"uploading an existing file"** link par click karein
4. Is `ChaicoApp` folder ke andar ka **saara content** (files aur folders)
   drag-and-drop karein us upload box mein
   - ⚠️ `node_modules` folder agar dikhe to usko **mat** upload karein
     (zaroorat nahi, aur bohot bara hai) — agar nahi bhi hai to koi masla nahi
5. Neeche **"Commit changes"** button dabayein
6. Upar **"Actions"** tab par jayein — ek build automatically shuru ho jayegi
   (peela dot = chal raha hai, hara tick = mukammal, 3-5 minute lagte hain)
7. Build complete hone par us workflow run par click karein, neeche scroll
   karein **"Artifacts"** section tak, aur **"Chaico-debug-apk"** download karein
   (ye ek `.zip` hogi jiske andar `app-debug.apk` hogi)
8. Wo `.apk` apne phone mein bhej kar install kar lein
   (agar "Unknown sources" warning aaye to allow kar dein — normal hai)

Bas itna hi — is process mein aapke apne computer par kuch bhi install
nahi hota.

---

## Option B — Android Studio (agar apne computer par khud build karna ho)

1. **Android Studio** install karein (free): https://developer.android.com/studio
2. `ChaicoApp` folder open karein → **"Open"** → `ChaicoApp/android` select karein
3. Gradle sync hone dein (internet chahiye, pehli baar time lagta hai)
4. **Build → Build Bundle(s) / APK(s) → Build APK(s)**
5. APK yahan milegi: `android/app/build/outputs/apk/debug/app-debug.apk`

### Command line se (agar sirf command-line tools chahiye, poora Studio nahi)
Terminal mein `ChaicoApp` folder ke andar:
```
npm install
npx cap sync android
cd android && ./gradlew assembleDebug
```
(Windows par: `gradlew.bat assembleDebug`) — isके liye bhi JDK aur Android SDK
command-line tools chahiye honge (Android Studio se halka, lekin phir bhi
install karna padega).

## Apna purana data (.db) import karna
1. App kholein → **Settings** tab
2. **"⬆ Import Backup (.db)"** button dabayein
3. Apni `chaico_data.db` file select karein (jo desktop app ke data folder mein thi)
4. Bas — items, sales, udhar, sab kuch phone par aa jayega

## Backup lena
Settings → **"⬇ Export Backup (.db)"** — isse ek `.db` file download hogi jo
aap Google Drive/WhatsApp par khud ko bhej kar safe rakh sakte hain.

## Play Store ke liye (agar future mein chahiye ho)
Play Store pe daalne ke liye **signed release APK/AAB** chahiye hoti hai
(debug APK nahi). Android Studio: **Build → Generate Signed Bundle / APK**
se ye ban jati hai (ek signing key banani hogi jo sambhal kar rakhni hai).
