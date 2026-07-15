# BOO - BCTC TT99

Ứng dụng nội bộ lập và kiểm tra báo cáo tài chính theo Thông tư 99/2025/TT-BTC từ sổ nhật ký PostgreSQL hoặc CSV. Backend tổng hợp số liệu phía server để không chuyển hàng trăm nghìn dòng bút toán xuống trình duyệt.

## Chức năng chính

- Lập B01 - Báo cáo tình hình tài chính.
- Lập B02 - Báo cáo kết quả hoạt động kinh doanh.
- Lập B03 - Báo cáo lưu chuyển tiền tệ theo phương pháp trực tiếp.
- Lập B09 - Bản thuyết minh báo cáo tài chính ở mức dữ liệu sổ cái hỗ trợ được.
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
- Riêng ngày chuyển đổi hệ thống `01/01/2026`, toàn bộ bút toán được xem là số đầu năm 2026: B01 tính lũy kế đến hết ngày này và B02, B03, bảng cân đối phát sinh không tính chúng vào phát sinh trong kỳ.
- Từ năm 2027 trở đi áp dụng quy tắc thông thường: số đầu năm B01 tính đến `31/12` năm trước; bút toán ngày `01/01` (ví dụ `01/01/2027`) vẫn được tính vào phát sinh của năm đó.
- B02 và B03 so sánh với cùng kỳ năm trước: `startDate - 1 năm` đến `endDate - 1 năm`.
- Lợi nhuận chưa kết chuyển dùng cho B01 được lấy từ số dư thực tế còn lại của các tài khoản tạm thời loại `5-9` tại `endDate`. Vì vậy kỳ chưa kết chuyển, kết chuyển một phần và đã kết chuyển hết đều dùng cùng một nguyên tắc, không cộng trùng với `4212`.

## Logic B01

B01 lấy số dư lũy kế theo tài khoản và bên dư bình thường:

- Tài sản dùng số dư Nợ, ví dụ tiền `111/112/113`, phải thu `131`, hàng tồn kho `151-157`, TSCĐ `211-213`.
- Nợ phải trả và vốn chủ sở hữu dùng số dư Có, ví dụ `331`, `333`, `334`, `338`, `341`, `411`, `421`.
- Tài khoản dự phòng và hao mòn được trình bày âm theo rule tương ứng.
- Các khoản phải thu/phải trả có thể cần tách Nợ/Có và ngắn/dài hạn; dòng không đủ dữ liệu để xác định chắc chắn được đánh dấu cần rà soát.

Các tài khoản loại `5-9` không được đưa trực tiếp vào tài sản hoặc nợ phải trả. Số dư Có trừ số dư Nợ còn lại của toàn bộ nhóm tài khoản tạm thời này được coi là kết quả thực tế chưa kết chuyển và được cộng vào:

- B01 mã `420b` - Lợi nhuận sau thuế chưa phân phối kỳ này.
- B01 mã `420 = 420a + 420b`.
- B01 mã `400` - Vốn chủ sở hữu.
- B01 mã `440` - Tổng cộng nguồn vốn.

Đây là phép tổng hợp trực tiếp từ sổ cái, không phải số vá. Ứng dụng không lấy chênh lệch `280 - 440` để tự cân. Công nợ `131/331` và các tài khoản có thể dư hai bên được tổng hợp theo từng `account_analytic` trước khi tách dư Nợ/dư Có. Các khoản không đủ dữ liệu kỳ hạn không được tự động ghi đồng thời vào cả ngắn hạn và dài hạn.

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
- Khi có kết chuyển, số B02 được đối chiếu với `911/4212`; B01 chỉ nhận phần số dư tài khoản tạm thời còn chưa kết chuyển.

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

B09 là bản thuyết minh hỗ trợ, tái sử dụng số đã xác định từ B01, B02 và B03 cho các bảng có thể chứng minh từ sổ cái, ví dụ tiền, phải thu, hàng tồn kho, phải trả, doanh thu, chi phí và lưu chuyển tiền. Ứng dụng luôn phát cảnh báo rằng B09 chưa phải bản thuyết minh hoàn chỉnh để phát hành.

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
- Nên sử dụng tài khoản PostgreSQL chỉ đọc và giới hạn truy cập mạng đến backend.
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
AUTH_USERNAME=admin
AUTH_PASSWORD_HASH=pbkdf2$sha256$210000$replace_salt$replace_hash
SESSION_SECRET=replace_with_32_plus_random_bytes
SESSION_TTL_HOURS=8
AUTH_COOKIE_SECURE=false
```

## Kiểm thử và build

```bash
npm run test:reports
npm run build
```

## Lưu ý nghiệp vụ

Ứng dụng hỗ trợ tổng hợp và kiểm soát số liệu, không thay thế xét đoán của kế toán. Các chỉ tiêu cần phân loại ngắn/dài hạn, thuyết minh định tính hoặc dữ liệu ngoài sổ cái phải được người có trách nhiệm rà soát trước khi phát hành báo cáo tài chính.
