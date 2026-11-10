### 1. Yêu cầu / vấn đề của khách

Khách trên **saunom.com** phát hiện hai block JSON-LD trên trang sản phẩm:

- Theme xuất **`@type: ProductGroup`**, với **`@id` tương đối**: `/products/havu-classic-sauna-hat#product`.
- Air Reviews xuất **`@type: Product`**, với **`@id` tuyệt đối**: `https://saunom.com/products/havu-classic-sauna-hat#product`.
- Khách cho rằng hai `@id` khác định dạng khiến Google không merge rating nhất quán và muốn app đổi `@id` sang relative path để khớp theme.

### 2. Kết luận của TS Elite 2

- **Phân loại: feature request, không phải bug.** Air Reviews tạo `@id` tuyệt đối theo thiết kế hiện tại.
- **❓ Root cause của việc rating merge không nhất quán chưa được xác định rõ.** Nhận định của khách rằng Google không merge được vẫn là phần cần làm rõ trong báo cáo.
- **🔹 Vấn đề có thể nằm hoàn toàn ở theme**, không liên quan đến Air Reviews; đây là khả năng được nêu, chưa phải nguyên nhân đã xác nhận.

### 3. Phân tích kỹ thuật

- **✅ Relative/absolute `@id` không phải root cause theo phân tích của TS Elite 2** — theo **W3C JSON-LD 1.1**, relative IRI được resolve dựa trên **`@base`** của document; hai định dạng resolve về cùng một entity IRI. Báo cáo nhận định Google có thể và thường sẽ merge được, nên đổi `@id` sang relative không giải quyết vấn đề rating không nhất quán.
- **✅ Air Reviews luôn tạo `@id` dạng absolute URL** — tại [`extensions/theme-extension/snippets/air-reviews-json-ld.liquid:38`](https://ts2.avada.net/chat?app=air-reviews&path=extensions%2Ftheme-extension%2Fsnippets%2Fair-reviews-json-ld.liquid&line=38), app dùng `product.url | prepend: request.origin`, sau đó thêm `#product`:

```liquid
{%- assign product_url = product.url | prepend: request.origin -%}
...
"@id": {{ product_url | append: '#product' | json }},
```

- **✅ Định dạng `@id` được hardcode trong theme extension Liquid snippet** — thay đổi logic trên cần **sửa source và deploy extension mới**; TS không thể tự fix bằng cấu hình hiện tại.
- **✅ Air Reviews xuất `@type: "Product"`** — tại **`air-reviews-json-ld.liquid:40`**.
- **✅ Báo cáo không tìm thấy emission `ProductGroup` hay `isVariantOf` trong toàn bộ Air Reviews codebase** — đối chiếu source của Air Reviews, bao gồm `air-reviews-json-ld.liquid`; snippet hiện xuất `Product` riêng lẻ.
- **✅ Guard của `aggregateRating` chỉ là kiểm tra metafield flag** — tại **`app-embed.liquid:51`**; không phải logic xử lý phân cấp entity.
- **✅ `AGGREGATE_RATING_SCRIPT` là code path legacy cho theme OS 1.x** — tại **`assets.js:136`** (`packages/functions/src/config/assets.js:131-146`); không có field **`@id`**, nên không thuộc vấn đề đang được mô tả.
- **✅ Ảnh khách gửi hiển thị “v26 – schema fix (test)”** — báo cáo xác định ảnh chụp từ **draft theme**, chưa đại diện cho theme live.
- **❓ Theme live có cùng `@type: ProductGroup` hay không chưa được xác nhận** — cần khách xác nhận cấu hình/schema trên live theme, thay vì chỉ dựa trên draft v26.
- **🔹 Nếu live theme cũng dùng `ProductGroup`**, báo cáo đặt vấn đề tương thích giữa schema của theme và **`Product` standalone không có linkage** của Air Reviews; cần Dev đánh giá trước khi xác định hướng sửa.

### 4. Phạm vi ảnh hưởng

- **Store:** `saunom.com` / `zkzggu-gu.myshopify.com`; báo cáo giới hạn ở store này.
- **Plan:** **FREE**.
- **Dữ liệu review:** **652 approved reviews**.
- **Phạm vi khách báo:** mọi product page có reviews.
- **Theme trong ảnh:** **“v26 – schema fix (test)”**; cần phân biệt draft này với theme đang live.

### 5. Đã xử lý

- **Avery (CS):** tạo ticket, đính kèm screenshots.
- **Andrew:** nhận ticket và chuyển trạng thái sang **Doing**.
- **Chưa có action kỹ thuật nào được thực hiện.**

### 6. Việc cần làm tiếp theo

1. **Xác nhận behavior trên live theme:** nhờ khách xác nhận theme live, không phải draft v26, có cùng **`@type: ProductGroup`** hay không. Nếu live theme dùng **`Product`** thông thường, vấn đề có thể ít nghiêm trọng hơn hoặc không tồn tại trên live store.
2. **Làm rõ root cause chưa được xác định:** Air Reviews không emit **`ProductGroup`** hay **`isVariantOf`**. **Nếu live theme cũng dùng `ProductGroup`**, báo cáo xem đây là vấn đề tương thích với `Product` standalone của app; cần **escalate Dev đánh giá**, TS không tự xử lý phần sửa này.
3. **Escalate Dev dưới dạng feature request nếu vấn đề tồn tại trên live:** đề nghị đánh giá cập nhật [`extensions/theme-extension/snippets/air-reviews-json-ld.liquid`](https://ts2.avada.net/chat?app=air-reviews&path=extensions%2Ftheme-extension%2Fsnippets%2Fair-reviews-json-ld.liquid&line=1). Mô tả rõ theme dùng **`ProductGroup`**, còn Air Reviews emit **`Product` riêng lẻ, không có linkage**.
4. **Đánh giá workaround tạm thời:** kiểm tra **“JSON-LD override” block setting** có khả dụng trên **plan FREE** hay không, thông qua plan gating trong source hoặc test trực tiếp theo đề xuất của báo cáo. Phải làm rõ trước khi offer workaround cho merchant; hiện **chưa có workaround được xác nhận**.

### 7. Đề xuất phản hồi khách

Draft cho Andrew, paraphrase theo báo cáo:

> Việc đổi `@id` giữa relative và absolute sẽ không giải quyết vấn đề rating đang được mô tả. Team cần xác nhận thêm behavior trên theme đang live của bạn, vì ảnh hiện tại được chụp trên draft theme “v26 – schema fix (test)”. Đây là limitation của JSON-LD template hiện tại mà team đang xem xét, không phải bug có thể sửa ngay. Bạn vui lòng xác nhận live theme có cùng cấu hình schema `ProductGroup` như draft theme hay không.
