# BOO - BCTC TT99

Ứng dụng nội bộ lập và kiểm tra báo cáo tài chính theo Thông tư 99/2025/TT-BTC từ sổ nhật ký PostgreSQL. Backend tổng hợp số liệu phía server để không chuyển hàng trăm nghìn dòng bút toán xuống trình duyệt.

## Chức năng chính

- Lập B01 - Báo cáo tình hình tài chính.
- Lập B02 - Báo cáo kết quả hoạt động kinh doanh.
- Lập B03 - Báo cáo lưu chuyển tiền tệ theo phương pháp trực tiếp.
- Lập B09-DN theo đúng 53 bảng nội dung của DOCX chuẩn, giữ nguyên thứ tự, tiêu đề và số cột; tự điền các tổng số có thể đối chiếu tin cậy và giữ dữ liệu chưa có là `null`/“Chưa nhập”.
- Bảng cân đối phát sinh theo tài khoản, tiểu khoản và `account_analytic`.
- Báo cáo tuổi nợ phải trả nhà cung cấp theo FIFO.
- Drilldown và xuất XLSX dữ liệu nguồn của từng chỉ tiêu.
- Xuất báo cáo ra XLSX, DOCX và PDF.
- Validation B01, B03, dữ liệu chưa phân loại và trường cần kế toán rà soát.

## Kiến trúc

- Frontend: React, Vite và TypeScript.
- Backend: Express và `pg`.
- Database: PostgreSQL, bảng nguồn `journal`.
- Frontend chỉ gửi kỳ báo cáo. Backend query, aggregate và trả payload báo cáo gọn.
- Raw source chỉ được tải theo chỉ tiêu và phân trang khi người dùng drilldown hoặc export.

## Dữ liệu nguồn

Các cột `journal` chính được sử dụng:

- `id`, `journal_id`, `journal_num`, `source_num`, `journal_name`
- `posting_date`, `status`
- `account_code`, `account_name`, `account_type`
- `root_account_code`, `root_account_name`
- `debit`, `credit`, `balance`
- `account_analytic`, `department`

Chỉ bút toán `status = 'Posted'` được tính. Hai tài khoản kỹ thuật sau bị loại khỏi toàn bộ báo cáo, drilldown và raw export:

- `More Account 111/112`
- `More Account 131`

## Kỳ báo cáo và số so sánh

- `startDate` và `endDate` xác định kỳ phát sinh của B02 và B03.
- B01 là báo cáo tại một thời điểm nên số cuối kỳ được tính lũy kế đến `endDate`.
- Số đầu năm được lấy đến hết ngày `31/12` năm trước. Bút toán số dư chuyển đổi phải được hạch toán ngày `31/12/2025` để nằm trong snapshot tháng 12/2025.
- Mọi bút toán ngày `01/01`, bao gồm `01/01/2026`, được xử lý như phát sinh thông thường của năm mới; ứng dụng không còn ngoại lệ chuyển ngày `01/01/2026` vào số đầu kỳ.
- B02 và B03 so sánh với cùng kỳ năm trước: `startDate - 1 năm` đến `endDate - 1 năm`.
- B01 chỉ lấy lợi nhuận chưa phân phối từ số dư thực tế của tài khoản `421`. Số dư còn lại của các tài khoản tạm thời loại `5-9` không được tự động cộng vào B01; nếu kế toán chưa kết chuyển thì checklist sẽ hiển thị B01 chưa cân để người lập báo cáo rà soát.

## Logic B01

B01 lấy số dư lũy kế theo tài khoản và bên dư bình thường. Đối với công ty cổ phần, mã `411 = 411a + 411b`: mã `411a` lấy TK `41111` (cổ phiếu phổ thông có quyền biểu quyết), mã `411b` lấy TK `41112` (cổ phiếu ưu đãi được phân loại là vốn chủ sở hữu). Cổ phiếu ưu đãi được phân loại là nợ phải trả tại mã `341` phải được nhập/phân loại riêng theo điều khoản hợp đồng, không được app tự động ghi trùng số TK `41112` vào cả nợ và vốn chủ sở hữu.

- Tài sản dùng số dư Nợ, ví dụ tiền `111/112/113`, phải thu `131`, hàng tồn kho `151-157`, TSCĐ `211-213`.
- Nợ phải trả và vốn chủ sở hữu dùng số dư Có, ví dụ `331`, `333`, `334`, `338`, `341`, `411`, `421`.
- Tài khoản dự phòng và hao mòn được trình bày âm theo rule tương ứng.
- Các khoản phải thu/phải trả có thể cần tách Nợ/Có và ngắn/dài hạn; dòng không đủ dữ liệu để xác định chắc chắn được đánh dấu cần rà soát.

Các tài khoản loại `5-9` không được đưa trực tiếp vào tài sản, nợ phải trả hoặc tự động cộng vào lợi nhuận chưa phân phối. B01 mã `420`, `420a`, `420b`, `400` và `440` chỉ phản ánh số dư thực tế của các tài khoản vốn chủ sở hữu, bao gồm `421`. Ứng dụng không lấy chênh lệch `280 - 440` hoặc kết quả chưa kết chuyển để tự cân; nếu sổ chưa kết chuyển, B01 được giữ nguyên và checklist báo lỗi để kế toán xử lý. Công nợ `131/331` và các tài khoản có thể dư hai bên được tổng hợp theo từng `account_analytic` trước khi tách dư Nợ/dư Có. Các khoản không đủ dữ liệu kỳ hạn không được tự động ghi đồng thời vào cả ngắn hạn và dài hạn.

Một số mapping đáng chú ý:

- Tiền B01 mã `111`: `111`, `112`, `113`.
- B01 mã `112` không tự động lấy toàn bộ `1281`. Kế toán chỉ bổ sung các khoản thực sự đáp ứng điều kiện tương đương tiền; nếu chưa đủ dữ liệu thì để manual mapping.
- Dự phòng chứng khoán kinh doanh: `2291`.
- Dự phòng đầu tư vào đơn vị khác: `2292`.
- Dự phòng phải thu khó đòi: `2293`.
- Dự phòng giảm giá hàng tồn kho: `2294`.

## Logic B02

B02 dùng phát sinh trong kỳ của các tài khoản doanh thu và chi phí:

- Toàn bộ bút toán có đối ứng `911` được loại khỏi lớp phát sinh nghiệp vụ gốc để bút toán kết chuyển không triệt tiêu doanh thu/chi phí. Nhờ vậy cùng một công thức dùng được cho tháng chưa kết chuyển, đã kết chuyển hoặc kỳ gồm cả hai trạng thái.
- Khi có kết chuyển, số B02 được đối chiếu với `911/4212`; B01 luôn chỉ nhận số dư thực tế đã ghi nhận tại tài khoản `421`.
- Mã `24` có tên đúng theo mẫu là “Chi phí đi vay”. Mã `70` (lãi cơ bản trên cổ phiếu) và `71` (lãi suy giảm trên cổ phiếu) chỉ áp dụng trong các trường hợp TT99 quy định; vì journal không có đủ lợi nhuận phân bổ và số lượng cổ phiếu bình quân gia quyền nên app giữ `null/Chưa nhập`, không tự điền 0.

- Mã `01`: phát sinh Có `511`, loại `5117` vì phần này được trình bày riêng tại mã `21`.
- Mã `02`: phát sinh Nợ `521`.
- Mã `10 = 01 - 02`.
- Mã `11`: giá vốn hàng bán `632`, loại `6327` vì phần này được trình bày riêng tại mã `21`.
- Mã `20 = 10 - 11`.
- Mã `21`: lãi/lỗ bán, thanh lý bất động sản đầu tư từ `5117` và `6327` theo số net.
- Mã `22`: doanh thu tài chính `515`.
- Mã `23`: chi phí tài chính `635`.
- Mã `24`: chi phí lãi vay từ các tiểu khoản `635411`, `635412`, `635413`.
- Mã `25`: chi phí bán hàng `641`.
- Mã `26`: chi phí quản lý doanh nghiệp `642`.
- Mã `31`: thu nhập khác `711`.
- Mã `32`: chi phí khác `811`.
- Mã `50 = 30 + 40`.
- Mã `51`: chi phí thuế TNDN hiện hành `8211`.
- Mã `52`: chi phí thuế TNDN hoãn lại `8212`.
- Mã `60 = 50 - 51 - 52`.

## Logic B03

B03 dùng phương pháp trực tiếp. Backend lấy các dòng tiền `111/112/113`, nhóm toàn bộ theo `journal_id`, tính biến động tiền thuần và phân bổ theo giá trị từng dòng đối ứng. Một chứng từ vừa trả gốc vừa trả lãi, hoặc vừa thu nợ vừa nhận tiền vay, được tách thành nhiều mã B03 thay vì giao toàn bộ cho rule đầu tiên. Chuyển tiền nội bộ giữa `111/112/113` có biến động tiền thuần bằng `0` và bị loại khỏi lưu chuyển tiền tệ.

### Hoạt động kinh doanh

- Mã `01`, tiền vào: đối ứng `511`, `33311`, `131`, `121`.
- Mã `01`, tiền ra: đối ứng `131` được ghi giảm mã `01`, ví dụ Nợ `131121`/Có `112`.
- Mã `02`, tiền ra: đối ứng `121`, `133`, `151-157`, `331`, `621`, `622`, `627`, `632`, `641`, `642`.
- Mã `03`, tiền ra: đối ứng `334`, `3382-3386`.
- Mã `04`, tiền ra: đối ứng `635`; khoản thanh toán qua `335` chỉ vào mã `04` khi lịch sử trích trước của cùng `account_analytic` đối ứng với `635`.
- Mã `05`, tiền ra: đối ứng `3334`, `821`.
- Mã `02`, tiền vào: hoàn tiền/hoàn ứng nhà cung cấp đối ứng `331`, ghi giảm dòng tiền chi nhà cung cấp.
- Mã `06`, tiền vào: đối ứng `138`, `244`, `338`, `711`, `141`.
- Mã `06`, tiền vào: đối ứng `344111` khi nhận ký quỹ, ký cược.
- Mã `06`, tiền ra: đối ứng `141` được ghi giảm mã `06`.
- Mã `07`, tiền ra: đối ứng `333` trừ `3334`, hoặc `138`, `244`, `338`.
- Mã `07`, tiền ra: đối ứng `344111` khi trả lại ký quỹ, ký cược.
- Mã `02`, tiền ra: đối ứng `641712` cho chi phí bán hàng/dịch vụ mua ngoài; tiền hoàn lại chi phí đối ứng `641712` được ghi dương vào mã `02` để giảm số tiền chi. Trường hợp không xác định rõ là hoàn chi phí phải để kế toán review trước khi chuyển sang mã `06`.
- Mã `20 = 01 + 02 + 03 + 04 + 05 + 06 + 07`.

### Hoạt động đầu tư

- Mã `21`, tiền ra: `211`, `212`, `213`, `217`, `241`.
- Mã `22`, tiền vào: `211`, `212`, `213`, `217`.
- Mã `23/24`: tiền chi/thu hồi cho vay và công cụ nợ, đối ứng `128`, `228`.
- Mã `25/26`: tiền chi/thu hồi đầu tư góp vốn, đối ứng `221`, `222`, `228`.
- Mã `27`, tiền vào: `515111` theo quy tắc tài khoản của doanh nghiệp. Validation luôn nhắc rà soát: lãi tiền gửi không kỳ hạn phải chuyển sang mã `01`, chỉ lãi cho vay/lãi tiền gửi có kỳ hạn/cổ tức/lợi nhuận được chia mới thuộc mã `27`.
- Mã `30 = 21 + 22 + 23 + 24 + 25 + 26 + 27`.

### Hoạt động tài chính

- Mã `31`, tiền vào: `411`.
- Mã `32`, tiền ra: `411`, `419`.
- Mã `33`, tiền vào: `341`.
- Mã `34`, tiền ra: `341`.
- Mã `35`, tiền ra: `3412`, `315`.
- Mã `36`, tiền ra: `421`.
- Mã `40 = 31 + 32 + 33 + 34 + 35 + 36`.
- Mã `50 = 20 + 30 + 40`.
- Mã `60` lấy trực tiếp từ số dư tiền và tương đương tiền đầu kỳ thực tế, không tính ngược từ tiền cuối kỳ.
- Mã `61` nhận các bút toán đánh giá lại tiền ngoại tệ đối ứng `413/515/635` khi nội dung chứng từ thể hiện chênh lệch tỷ giá; nếu không có nghiệp vụ phù hợp thì bằng `0`.
- Mã `70 = 50 + 60 + 61`; sau đó mới đối chiếu độc lập với B01 mã `110`. Chênh lệch không bị tự vá mà được cảnh báo để kiểm tra dòng tiền chưa phân loại, tương đương tiền hoặc tỷ giá.

Dòng tiền không match rule không bị đoán. Ứng dụng đưa chúng vào `Unclassified`, cho phép xuất XLSX để kế toán bổ sung mapping.

## Logic B09

B09 triển khai cấu trúc chính thức của Mẫu B09-DN tại Phụ lục IV TT99: phần I-V, VII-X và đúng 53 bảng nội dung trong DOCX chuẩn (40 bảng phần V, 12 bảng phần VII, 1 bảng phần VIII). Schema giữ nguyên thứ tự, tiêu đề, số hàng và lưới cột của từng bảng; kiểm thử khóa phân bố 31 bảng 3 cột, 12 bảng 5 cột, 2 bảng 6 cột, 7 bảng 7 cột và 1 bảng 10 cột. Các tổng số chứng minh được được lấy từ B01/B02; mọi ô chi tiết chưa có căn cứ từ journal/sổ phụ/hợp đồng được lưu là `null` và hiển thị “Chưa nhập”, tuyệt đối không biến thành số 0. Chính sách kế toán, bảng tăng giảm, kỳ hạn, tài sản bảo đảm, cam kết, bên liên quan và dữ liệu ngoài journal vẫn phải được người lập bổ sung, phê duyệt trước khi phát hành.

Drilldown B01/B02/B03 tái sử dụng đúng cùng tập dòng, điều kiện tài khoản, tài khoản loại trừ, bên Nợ/Có, dấu cộng/trừ và phép tách dư theo đối tượng với dòng báo cáo. API trả đồng thời số báo cáo, tổng drilldown và chênh lệch; giao diện chỉ báo đã đối chiếu khi chênh lệch trong ngưỡng 1 đơn vị.

Raw source của Bảng cân đối phát sinh lọc trực tiếp từng dòng journal theo đúng `account_code` và `account_analytic`; không mở rộng ra các dòng khác trong cùng `journal_id/journal_num`. Khi dòng báo cáo đã breakdown theo đối tượng, raw dùng so khớp chính xác đối tượng đó; khi chỉ dùng ô lọc đối tượng, raw tái sử dụng cùng điều kiện tìm kiếm không phân biệt hoa/thường. Cột “Số dòng” lấy số phát sinh tăng thêm của từng snapshot tháng, không cộng lặp số dòng lũy kế. `posting_date` là ngày kế toán không có timezone và luôn được API/XLSX giữ nguyên dạng `YYYY-MM-DD`, không chuyển sang UTC.

Các disclosure cần dữ liệu ngoài sổ nhật ký như chính sách kế toán, thời hạn hợp đồng, quan hệ bên liên quan, giá trị hợp lý, tài sản hạn chế sử dụng hoặc giải trình định tính không được tự suy đoán. Chúng được đánh dấu cần nhập hoặc rà soát thủ công.

## Bảng cân đối phát sinh

- Dư đầu kỳ: lũy kế đến ngày trước `startDate`.
- Phát sinh Nợ/Có: từ `startDate` đến `endDate`.
- Dư cuối kỳ: lũy kế đến `endDate`.
- Có thể lọc theo tiền tố tài khoản và `account_analytic`.
- Có thể breakdown theo `account_analytic` và xuất raw source của từng dòng.

## Tuổi nợ phải trả

- Chỉ dùng tài khoản gốc `331` và nhóm theo `account_analytic`.
- Phát sinh Có `331` tạo lô công nợ theo `posting_date`.
- Phát sinh Nợ `331` giảm lô cũ nhất trước theo FIFO.
- Tuổi nợ tính từ ngày phát sinh Có gốc đến `endDate`.
- Nhóm tuổi: `0-30`, `31-60`, `61-90`, `91-120`, trên `120` ngày.
- Tổng tuổi nợ được kiểm soát với số dư Có còn lại của `331` theo cùng đối tượng.

## Bảo mật

- Credential PostgreSQL chỉ nằm trong `.env` tại backend và không được đóng gói vào frontend.
- `.env`, log, build output, test output và file tạm đều bị loại khỏi Git.
- API sử dụng đăng nhập, session cookie HTTP-only, session TTL và rate limit đăng nhập.
- Nên sử dụng tài khoản PostgreSQL chỉ đọc đối với `journal`, chỉ cấp quyền ghi cho bảng snapshot và giới hạn truy cập mạng đến backend.
- Không commit mật khẩu, hash thật hoặc session secret vào repository.

## Cài đặt

Yêu cầu Node.js 20 trở lên và PostgreSQL có bảng `journal` đúng schema.

```bash
npm install
Copy-Item .env.example .env
npm run dev
```

Frontend: `http://127.0.0.1:3020`

Backend: `http://127.0.0.1:3021`

Các biến môi trường chính:

```env
PGHOST=your-postgresql-host
PGPORT=5432
PGDATABASE=your-database
PGUSER=your-readonly-user
PGPASSWORD=your-password
API_PORT=3021
SESSION_SECRET=replace_with_32_plus_random_bytes
SESSION_TTL_HOURS=8
AUTH_COOKIE_SECURE=false
SNAPSHOT_SCHEDULER_ENABLED=true
SNAPSHOT_MIGRATION_MONTH=2025-12
SNAPSHOT_TIME_ZONE=Asia/Ho_Chi_Minh
SNAPSHOT_SCHEDULE_HOUR=3
```

## Tài khoản và phân quyền

- Tài khoản được lưu trong `public.app_users`; backend không dùng tài khoản hardcode hoặc password trong `.env`.
- Mật khẩu chỉ lưu dưới dạng PBKDF2-SHA256 có salt riêng và 600.000 vòng lặp.
- Role `admin` được xem Mapping, Validation, Snapshot và gọi API `/api/admin/...`.
- Role `user` không thấy và không gọi được các chức năng admin.
- Menu `Tài khoản` chỉ dành cho admin: tạo tài khoản, đổi role, khóa/mở khóa và đổi mật khẩu.
- Đổi mật khẩu yêu cầu xác nhận mật khẩu admin hiện tại; mọi session cũ của tài khoản được đổi sẽ bị vô hiệu hóa.
- Admin không thể tự hạ quyền hoặc khóa chính mình, và hệ thống luôn giữ ít nhất một admin đang hoạt động.
- CSV fallback đã được gỡ khỏi giao diện cho mọi role.
- File tạo schema nằm tại `server/migrations/001_app_users.sql`.

## Snapshot số dư tài khoản

- Backend kiểm tra mỗi ngày sau `SNAPSHOT_SCHEDULE_HOUR` và tự tạo các snapshot tháng còn thiếu đến tháng đã hoàn tất gần nhất.
- Khi backend khởi động sau giờ chạy, job cũng tự kiểm tra và tạo bù các tháng còn thiếu.
- Mỗi snapshot được tổng hợp theo `account_code`, `root_account_code` và `account_analytic`.
- B01 và CĐ phát sinh đọc trực tiếp `account_balance_snapshots`; `monthly_report_aggregate_controls` xác nhận tháng và `batch_id` đã hoàn tất. View `current_account_balance_snapshots` không còn được sử dụng hoặc duy trì.
- Toàn bộ một lần tạo hoặc rebuild chạy trong một transaction và dùng PostgreSQL advisory lock; lỗi ở bất kỳ tháng nào sẽ rollback cả batch.
- Menu `Snapshot` và API `/api/admin/snapshots...` chỉ dành cho tài khoản có role `admin`. Backend trả HTTP 403 cho user không có quyền admin.
- Khi Odoo sửa dữ liệu quá khứ, admin phải đồng bộ lại `journal`, sau đó chọn tháng sớm nhất bị ảnh hưởng và chạy tính lại đến tháng hoàn tất hiện tại.
- Khi chuyển bút toán số dư đầu kỳ từ `01/01/2026` về `31/12/2025`, admin chọn tính lại từ `12/2025`. Snapshot ngày `31/12/2025` được tạo theo đúng dữ liệu journal tháng 12 như mọi snapshot tháng khác; mọi bút toán ngày `01/01/2026` vẫn là phát sinh tháng 01/2026.
- Mỗi ngày cuối tháng chỉ lưu một version vật lý. Khi rebuild từ một tháng, backend xóa snapshot và các aggregate liên quan từ tháng đó đến tháng đóng gần nhất trong cùng transaction, sau đó dựng lại và đối chiếu journal; nếu có lỗi, toàn bộ thao tác được rollback.
- Sau khi admin tạo tháng còn thiếu hoặc tính lại snapshot thành công, frontend tự gọi lại API lập báo cáo cho kỳ đang chọn. Không cần quay về menu Data để bấm Query journal; chỉ khi lần tự làm mới báo lỗi mới cần query lại thủ công.
- Ràng buộc database không cho tồn tại hai version của cùng một tháng và cùng khóa tài khoản/chứng từ. Migration áp dụng quy tắc này nằm tại `server/migrations/004_single_snapshot_version.sql`.

## Kiểm thử và build

```bash
npm run test:reports
npm run test:snapshots
npm run test:aggregates
npm run test:dates
npm run test:users
npm run build
```

### Nguồn dữ liệu tối ưu cho báo cáo

- B01 và CĐ phát sinh lấy snapshot tháng đóng gần nhất rồi cộng journal của phần kỳ chưa đóng; đây là phép cộng lũy kế đã được đối chiếu với journal, không phải số ước tính. Nếu chưa có snapshot thì tự fallback về journal.
- B02 dùng `current_monthly_profit_loss_aggregates` khi kỳ báo cáo gồm trọn các tháng đã đóng và đủ coverage; kỳ có ngày lẻ hoặc thiếu bất kỳ tháng aggregate nào sẽ tính toàn kỳ từ journal. Quy tắc loại journal kết chuyển có TK 911 được áp dụng giống nhau ở cả hai nguồn.
- B03 dùng `current_monthly_cash_flow_movements` khi kỳ báo cáo gồm trọn các tháng đã đóng và đủ coverage; kỳ có ngày lẻ hoặc thiếu bất kỳ tháng aggregate nào sẽ tính toàn kỳ từ journal. Aggregate lưu dữ liệu đối ứng để vẫn áp dụng mapping hiện hành và truy vết raw journal.
- Tuổi nợ nhà cung cấp dùng `current_payable_open_item_snapshots`; kỳ lẻ lấy open items cuối tháng trước rồi replay phát sinh TK 331 đến ngày báo cáo.
- Các bảng aggregate được tạo bởi `server/migrations/002_report_aggregates.sql` và được ghi cùng transaction/batch với snapshot số dư. Một batch chỉ trở thành hiện hành khi toàn bộ số dư và aggregate đều commit thành công.
- Migration `server/migrations/006_drop_current_balance_snapshot_view.sql` chuyển các view aggregate sang join trực tiếp với control rồi xóa view snapshot phiên bản cũ.
- `monthly_report_aggregate_controls` được tạo bởi `server/migrations/005_report_aggregate_controls.sql`. Mỗi tháng chỉ có control row sau khi balance, B02, B03 và tuổi nợ đã cùng được tạo; balance, B02 và B03 aggregate đã đối chiếu raw journal. Scheduler dùng control row thay vì chỉ nhìn snapshot số dư, nên batch thiếu aggregate sẽ tự được rebuild.
- Bản chính thức (XLSX, DOCX, PDF) chỉ chứa biểu mẫu và số liệu báo cáo, không chứa công thức hoặc trạng thái mapping. Excel QA được xuất riêng và mới chứa validation, công thức, mapping, cash QA và dòng nguồn phục vụ rà soát nội bộ.
- XLSX, DOCX và PDF chính thức đều xuất B09-DN; các ô ngoài khả năng chứng minh của journal được giữ là “Chưa nhập”, không tự điền số giả định.

## Lưu ý nghiệp vụ

Ứng dụng hỗ trợ tổng hợp và kiểm soát số liệu, không thay thế xét đoán của kế toán. Các chỉ tiêu cần phân loại ngắn/dài hạn, thuyết minh định tính hoặc dữ liệu ngoài sổ cái phải được người có trách nhiệm rà soát trước khi phát hành báo cáo tài chính.
