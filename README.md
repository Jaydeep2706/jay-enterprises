# जय इंटरप्राइजेस — Render Deployment

## क्या शामिल है
- ग्राहक वेबसाइट (हिंदी/अंग्रेज़ी टॉगल, कार्ट, डिलीवरी शुल्क)
- ग्राहक ऑर्डर सर्वर पर SQLite डेटाबेस में सेव
- WhatsApp पर ऑर्डर विवरण भेजने का विकल्प
- पासवर्ड-हैश और सर्वर सेशन वाला एडमिन लॉगिन
- एडमिन से ऑर्डर की स्थिति बदलना और सामान जोड़ना/हटाना
- Render Blueprint (`render.yaml`) और Persistent Disk का कॉन्फ़िगरेशन

## Render पर तैनाती
1. इस प्रोजेक्ट की सभी फाइलें GitHub repository के ROOT में अपलोड करें (ZIP को extract करके)।
2. Render Dashboard → New → Blueprint चुनें और GitHub repository कनेक्ट करें।
3. Render `render.yaml` पढ़कर Web Service और 1GB Persistent Disk बनाएगा। `starter` प्लान के लिए भुगतान लागू होगा।
4. Service के Environment में ये variables सेट करें:
   - `SESSION_SECRET`: कम-से-कम 32 अक्षरों का लंबा random secret
   - `ADMIN_USERNAME`: अपना admin username
   - `ADMIN_PASSWORD`: अलग, मजबूत पासवर्ड (कम-से-कम 12 अक्षर)
   - `NODE_ENV=production`
   - `DATABASE_PATH=/var/data/jay-enterprises.sqlite`
   - `SHOP_WHATSAPP=917389253333`
5. Deploy करें और `https://<service-name>.onrender.com/health` खोलकर `{ "ok": true }` देखें।
6. `https://<service-name>.onrender.com/` ग्राहक वेबसाइट और `/admin` एडमिन पैनल है।

## महत्वपूर्ण सुरक्षा बातें
- `.env`, पासवर्ड, OTP, session secret या कोई निजी कुंजी GitHub पर अपलोड न करें।
- Admin credentials केवल Render Environment में सेट करें।
- Render पर Persistent Disk अनिवार्य है; SQLite डेटा को ephemeral filesystem पर न रखें।
- लॉन्च से पहले मजबूत पासवर्ड, बैकअप प्रक्रिया, गोपनीयता नीति, नियम/शर्तें और वास्तविक फोन पर ऑर्डर परीक्षण करें।
- Admin पैनल का URL सार्वजनिक हो सकता है; सुरक्षा लॉगिन से है। पासवर्ड किसी से साझा न करें।
- Starter catalog में अभी कोई उत्पाद seed नहीं है। दुकान संचालक `/admin` से उत्पाद जोड़ेंगे।
- यह launch candidate है, स्वतंत्र security audit/production acceptance test का विकल्प नहीं है।

## स्थानीय परीक्षण
Node.js 20+ स्थापित करके:
1. `npm install`
2. `SESSION_SECRET` (32+ chars), `ADMIN_USERNAME`, `ADMIN_PASSWORD` सेट करें।
3. `npm start`
4. `http://localhost:10000` और `http://localhost:10000/admin` खोलें।

## व्यापार सेटिंग
जय इंटरप्राइजेस, शिव मंदिर के पास, बंडोल, जिला सिवनी, मध्य प्रदेश।
WhatsApp: 7389253333
डिलीवरी: ₹500 तक ₹10; ₹500 से अधिक मुफ्त।
समय: सुबह 8 से रात 9 बजे।
