# **Accessibility — DFU Setup Checklist**

Checklist để CS \+ TS set up giúp 1 store (DFU). Mỗi store làm 1 bản, tick từng việc.

Mục tiêu:

**(1)** widget accessibility chạy on-brand trên storefront;

**(2)** Accessibility score **≥ 90** (Low risk): Lý tưởng, có thể thấp hơn phụ thuộc vào loại mã lỗi của store

**(3)** Statement published and updated.

## **Mấy điều cần nhớ trước**

* **Đối tượng:** mọi MC cần set up / nâng điểm — mới cài, widget off, hoặc điểm \< 90\.  
* **CS tự làm** phần onboard \+ phần audit trong app (chạy scan, lọc "Solved by SEA", mark FP, bật Auto Alt-Text), **làm giao diện trên built-in Widget Settings**  
* **TS** verify False Positive trên store thật \+ sửa hộ theme code (Collaborator access) \+ chốt cái nào cần báo Dev theme.  
* **KHÔNG tạo ticket DFU mới** nếu MC đã có ticket DFU active → update ticket cũ.  
* Xin **THEME \+ MENU \+ PAGES** để TS sửa lỗi và add page vào Menu  
* SCREENSHOT result của scanner TRƯỚC \+ SAU khi sửa

## **B1. Display**

* \[ \] Widget được bật và on brand  
* \[ \] **Alignment:** phù hợp với các widget khác của store KH  
* \[ \] **Font family:** matches the theme font  
* \[ \] **Button: vị trí và size hợp lý, không conflict, đè các button khác trên site**  
* \[ \] **Default language \+ Detect** — Browser's / Store's / Customer's IP (chọn theo store; **Store's** \= theo Shopify Markets).  
* \[ \] **Accessibility Statement** hoạt động tốt, không lỗi heading, add vào menu, đặc biệt với EAA

---

## **B2. SCANNER AUDIT (mục tiêu điểm ≥ 90 \- TS)**

CS assign TS trong ca để TS hỗ trợ audit scanner result (gửi lại link scan vào trong ticket)

**Verify false positive**

* \[ \] **3.3.4** — "Form quan trọng không có bước xác nhận" (−10)

   Lỗi thật: form thanh toán/đăng ký cho submit thẳng, khách bấm nhầm là mất tiền, không có bước review.

   Scanner bắt: form chứa keyword payment, checkout, credit, purchase, order, subscribe, register, delete — hoặc chỉ cần form có hơn 4 input — mà không thấy nút Confirm/Review.

   Vì sao thường FP: cái "hơn 4 input" là lý do chính. Form filter sản phẩm, form lead/newsletter nhiều field đều dính. Submit nhầm form filter thì không mất gì → mark solved.

* \[ \] **2.2.6** — "Hết phiên mà không báo trước" (−5)

   Lỗi thật: trang tự logout / giỏ hàng hết hạn, khách đang điền dở mất sạch dữ liệu.

   Scanner bắt: trong `<script>` có `setTimeout`/`setInterval` đi kèm chữ `session`, `timeout`, `inactive`, `expire`.  
   Lưu ý: gần như mọi store Shopify đều dính, vì hầu như script nào cũng có `setTimeout`. Đây không phải "thường FP" — nó gần như luôn FP.

   Vì sao thường FP: captcha tự refresh, script analytics, countdown sale đều dùng đúng bộ từ đó mà chẳng đá vào phiên của khách. Xác nhận không có gì hết hạn thật → mark solved.

* \[ \] **1.4.13** — "Nội dung hover không tắt được" (−5)

   Lỗi thật: tooltip hiện khi rê chuột nhưng không bấm Esc tắt được, không rê vào trong được, hoặc tự biến mất trước khi kịp đọc.

   Scanner bắt: `[title]`, `popover`, Tippy/Bootstrap tooltip, handler hover inline — không thấy cơ chế dismiss.

   Vì sao thường FP: element luôn hiển thị sẵn (không phải hover mới hiện) hoặc chỉ là animation trang trí thì không thuộc phạm vi 1.4.13 → mark solved.

* \[ \] **3.2.1** — "Vừa focus vào ô đã bị nhảy trang" (−1)

   Lỗi thật: click/tab vào input là trang tự redirect hoặc form tự submit. Người dùng bàn phím bị hất đi khi chưa làm gì.

   Scanner bắt: script có focus đi cùng `location.href` / `window.location` / `form.submit()`.

   Vì sao thường FP: script captcha thường gắn handler kiểu này cho mục đích khác → mark solved.

* \[ \] **3.2.2** — "Dropdown tự submit" (−1)

   Lỗi thật: chọn một option trong `<select>` là trang đổi ngay, người dùng bàn phím mới lướt tới option thứ nhất đã bị nhảy.

   Vì sao thường FP: dropdown filter/sort của collection page — hành vi cố ý, có nhãn rõ ràng → mark solved.

* \[ \] **3.3.3** — "Báo lỗi chung chung" (−1)

   Lỗi thật: form báo 1.mỗi chữ "Lỗi" / "Invalid", khách không biết sai chỗ nào.

   Scanner bắt: container có text ngắn dưới 15 ký tự: "Sold out", "Required", "Add to cart", "Hết hàng"… lọt vào selector `.error`, `.alert-danger`, `.has-error`, `.validation-message`, `[aria-errormessage]`

   Vì sao thường FP: đó là div mẫu rỗng theme để sẵn, chỉ đổ text khi có lỗi thật. Trigger lỗi thử xem message thật có mô tả rõ không — có thì mark solved.

\<aside\>  
 ❗

Chỉ mark solved sau khi tận mắt verify. Issue chưa resolve chảy thẳng vào Accessibility Statement công khai — văn bản khách dùng chứng minh tuân thủ EAA/ADA. Mark lỗi thật để kéo lên 90 \= đưa tuyên bố sai vào hồ sơ pháp lý của khách. Không đạt 90 thì báo đúng lý do.

\</aside\>

**Sửa lỗi thật (TS làm hộ / dev theme)**

* \[ \] **1.3.1** — "Tiêu đề sai cấp / thiếu H1" (−10)

   Lỗi thật: nhảy H1 → H3 bỏ qua H2, hoặc trang không có H1 nào. Screen reader và Google đều mất mạch, ảnh hưởng cả SEO.  
   Lưu ý: trang thiếu H1 thì scanner KHÔNG kiểm skip cấp. TS thêm H1 xong rescan có thể thấy mọc ra lỗi skip mới — không phải fix hỏng, mà là lỗi trước đó bị che.

   Kiểm tra: inspect hoặc dùng widget của app. Scanner báo khi cấp hiện tại \> cấp trước \+ 1\.

   Sửa: đổi tag heading cho đúng bậc; thiếu H1 thì thêm vào section đầu trang (yêu cầu cần thêm tiêu đề có ý nghĩa \- ví dụ tên product/collection/page). Hay gặp ở landing page custom và collection page.  
   Lưu ý: H1 ẩn bằng `.sr-only`/`.visually-hidden` (clip) vẫn hợp lệ. Nhưng ẩn bằng `display:none`/`visibility:hidden`/`hidden`/`d-none` thì scanner coi như KHÔNG có → vẫn báo missing-h1.

   ⚠️ Riêng `/pages/accessibility-statement` bị skip cấp là bug template Avada → nếu báo lỗi thì cần escalate lên dev, đừng đổ cho theme khách hoặc sửa ghi đè.

* \[ \] **3.3.8** — "Mật khẩu khó mà không cho xem" (−10)

   Lỗi thật: bắt mật khẩu có hoa/số/ký tự đặc biệt nhưng không có nút hiện mật khẩu. Người trí nhớ kém gõ mù gần như không tạo nổi.

   Scanner bắt: có `input[type="password"]` (không bị ẩn) VÀ tìm thấy 1 trong  
   10 từ khoá tiếng Anh — `uppercase`, `lowercase`, `upper case`, `lower case`,  
   `capital letter`, `number`, `symbol`, `special character`, `complexity`,  
   `characters` — ở **đúng 2 nơi**:

  1. **Text nằm trần trong thẻ cha trực tiếp** của ô password. Chữ bọc trong thẻ con (`<small>`, `<span>`, `<p>`…) thì **KHÔNG** tính. Đa số theme viết kiểu bọc thẻ, nên nguồn này ít khi là thủ phạm.  
  2. **\<label for="id-của-ô-password"\>** — lấy toàn bộ text kể cả trong thẻ con, và label nằm ở đâu trong trang cũng được.  
      → Thực tế **\~90% ca là do label**, hay gặp nhất là chữ *characters*: \<label for="pwd"\>Password (min. 8 characters)\</label\> là dính.

⚠️ **Chỉ bắt tiếng Anh**. Store tiếng Việt ghi "Mật khẩu phải có chữ hoa và số"  
 → không dính. Nếu store tiếng Việt mà vẫn báo 3.3.8, chuỗi tiếng Anh đó đến từ  
 theme gốc hoặc app bên thứ ba, không phải nội dung khách viết.

 **Tìm đúng chỗ gây lỗi:** scan result không giúp được — nó luôn ghi  
 instances: 1 và location cố định "Password input with complexity  
 requirements", dù trang có bao nhiêu ô password. Dán snippet này vào Console:

 const IND=\['special character','uppercase','lowercase','number','symbol',  
           'complexity','characters','upper case','lower case','capital letter'\];  
document.querySelectorAll('input\[type="password"\]').forEach(inp=\>{  
  const hits=\[\], p=inp.parentNode;  
  if(p) \[...p.childNodes\].filter(n=\>n.nodeType===3)  
        .map(n=\>n.textContent.trim()).filter(Boolean)  
        .forEach(t=\>{ if(IND.some(i=\>t.toLowerCase().includes(i)))  
          hits.push(\['text trần trong parent', t\]); });  
  if(inp.id){ const l=document.querySelector(\`label\[for="\${inp.id}"\]\`);  
    if(l){ const t=l.textContent.trim();  
      if(IND.some(i=\>t.toLowerCase().includes(i))) hits.push(\['label\[for\]', t\]); } }  
  console.log(inp, hits.length ? hits : 'không dính');  
});

*  Sửa:

   **Phần A (verify để thật sự tuân thủ luật)** — làm TRƯỚC, bắt buộc:

   Mở form login/register, kiểm tra 2 thứ:

| Kiểm tra | Kết luận | Việc phải làm |
| ----- | ----- | ----- |
| Ctrl+V dán được vào ô password **và** input có `autocomplete="current-password"` (đăng nhập) / `"new-password"` (đăng ký) | ✅ Đã tuân thủ | Không sửa gì. Sang Phần B |
| Paste bị chặn (`onpaste="return false"`) hoặc thiếu/sai `autocomplete` | ❌ Chưa tuân thủ | **Khôi phục paste \+ thêm `autocomplete` đúng.** Không sửa được (theme premium khoá) → báo dev theme khách |

**Phần B (để app hết báo lỗi)** — làm SAU khi A đã đạt.

 Scanner chỉ đọc chữ, không nhìn được Phần A, nên A đạt rồi rescan vẫn báo. Chọn 1:

 **B1 — sửa được theme:** tách yêu cầu ra khỏi `<label>`, dùng `aria-describedby`.

 \<label for="pwd"\>Password\</label\>  
\<input type="password" id="pwd" aria-describedby="pwd-hint"\>  
\<small id="pwd-hint"\>Must contain uppercase and a number\</small\>

*  Label sạch từ khoá → rescan hết báo. Đây không phải mẹo lách: label ngắn gọn \+  
   mô tả chi tiết đưa vào `aria-describedby` đúng là cách làm chuẩn a11y, screen  
   reader vẫn đọc đủ cả hai. Vừa sạch scan vừa thật sự tốt hơn cho khách.

   **B2 — không sửa được theme**: mark as solved. An toàn với riêng mã này vì 3.3.8  
   chỉ có 1 type (cognitive-complexity), không giấu theo lỗi thật nào khác

* \[ \] **2.4.2** — "Thiếu tiêu đề tab trình duyệt" (−1)

   Lỗi thật: `<title>` rỗng hoặc không có. Mở nhiều tab không biết tab nào, screen reader không đọc được tên trang.

   Sửa trong `theme.liquid`: `<title>{{ page_title }} | {{ shop.name }}</title>`.

* \[ \] **3.1.1** — "Không khai báo ngôn ngữ" (−1)

   Lỗi thật: thẻ `<html>` thiếu `lang` (hoặc `lang=""`). Screen reader đọc tiếng Việt bằng giọng English, nghe không ra chữ gì.

   Sửa trong `theme.liquid`: `<html lang="{{ request.locale.iso_code }}">` — tự bám theo ngôn ngữ đang bật.

* \[ \] **1.1.1 / 4.1.2** — nếu khách muốn sửa thật (thay vì chỉ dùng tính năng Auto Alt-Text của app): thêm `alt` / `aria-label` cho ảnh ở theme code.

* \[ \] Cái ngoài tầm TS (theme premium khoá / custom phức tạp) → **báo dev theme** khách kèm finding \+ action needed.

