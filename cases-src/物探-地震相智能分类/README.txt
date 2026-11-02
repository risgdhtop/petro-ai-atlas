案例包：物探-地震相智能分类
========================================
id          seismic-facies
sceneId     s2
版本        1.0.0    更新 2026-11-02

放置位置
  把本文件夹整个放到主站的 cases-src/ 下（或直接拖进「＋ 添加案例」），
  主站通过 case.json 读取背景与流程，通过 demo/index.html 运行交互示范。

文件
  case.json          元信息 + 专业背景 + 案例流程（三 tab 里的前两个）
  demo/index.html    交互示范页（整页模式，沙箱 iframe 内运行）
  demo/demo.css      示范页样式
  demo/demo.js       示范页逻辑（纯前端，无外部依赖、无网络请求）

接入（两种任选）
  1) 主站「＋ 添加案例」：把这个文件夹拖进虚线框 -> 校验 -> 校验并添加。
     落地存在 localStorage，刷新仍在；可在案例库页导出。
  2) 源码接入：在 index.html 中、welllog-layer 之后加一行
       <script src="assets/cases/seismic-facies.case.js"></script>
     （该文件由 build.py 生成，内容等价于本包内 case.json + demo/）

注意
  - demo/ 里的三个文件必须同时存在，index.html 只通过相对路径引 demo.css / demo.js。
  - 本包不发起任何网络请求，所有数据在浏览器内合成。
