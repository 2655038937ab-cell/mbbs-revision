# Google Drive 自动上传设置（Service Account）

本应用可以把生成的课程 PDF 自动上传到你的 Google Drive。
上传用的是 **Service Account**，凭据只放在服务器上（`data/google-service-account.json`），
**不会暴露给浏览器，也不会进入 git / Docker 镜像**（`data/` 已被忽略）。

---

## 你需要准备的东西

- 一个 Google 账号（用来创建 Service Account）
- **一个 Shared Drive（共享云端硬盘）**，或用它里的一个文件夹来存放 PDF
  > ⚠️ 重要：Service Account **没有个人存储配额**，不能上传到「我的云端硬盘 / My Drive」根目录或普通文件夹。必须上传到 **Shared Drive**。

---

## 步骤 1：创建 Service Account

1. 打开 Google Cloud Console：<https://console.cloud.google.com/>
2. 登录你的 Google 账号。
3. 顶部左侧如果还没项目，先 **Create Project / 新建项目**（名字随意，例如 `mbbs-drive`），然后选中它。
4. 左侧菜单：**IAM & Admin（IAM 与管理）→ Service Accounts（服务账号）**。
5. 点顶部 **+ Create Service Account（创建服务账号）**。
6. 填写：
   - Name（名称）：`mbbs-drive-upload`
   - Service account ID：会自动变成邮箱
7. 中间 "Grant this service account access to project"（授予权限）可以**直接跳过/继续**（不用给角色）。
8. 点 **Done（完成）**。

---

## 步骤 2：下载 JSON 密钥

1. 在 Service Accounts 列表里，点你的服务账号那一行最右边的 **⋮（三点）→ Manage keys（管理密钥）**。
2. 点 **Add key（添加密钥）→ Create new key（新建密钥）**。
3. 类型选 **JSON**，点 **Create**。
4. 浏览器会下载一个形如 `mbbs-drive-upload-xxxx.json` 的文件。**这个文件就是你的凭据，务必保密。**

---

## 步骤 3：把 JSON 放到服务器上

把这个 JSON 文件复制到项目目录里，并**严格改名为**：

```
data/google-service-account.json
```

例如：

```bash
# 本地启动时
mkdir -p data
mv ~/Downloads/mbbs-drive-upload-xxx.json data/google-service-account.json
chmod 600 data/google-service-account.json
```

> 注意：文件名**必须**是 `google-service-account.json`，代码是按这个固定路径找的。
> `data/` 已被 git/Docker 忽略，不会提交、不会打进镜像。

---

## 步骤 4：把 Shared Drive 共享给 Service Account

> 这一步**必须**用 Shared Drive（共享云端硬盘）。My Drive 里的文件夹不行——Service Account
> 没有个人配额，只有 Shared Drive 能接收它的上传。

1. 打开 Google Drive，左侧栏找到 **Shared drives（共享云端硬盘）**。
2. 点 **+ New（新建）** 创建一个共享云端硬盘，例如 `MBBSExports`。
   - 也可以直接用里面现成的子文件夹。
3. 打开那个 Shared Drive（或子文件夹），点右上角 **📤 Share（共享）**。
4. 在「Add people」里粘贴 **Service Account 的邮箱**（形如 `mbbs-drive-upload@你的项目.iam.gserviceaccount.com`）。
5. 权限选 **Content Manager（内容管理者）** 或至少 **Editor（编辑者）**。
6. 点 **Send / Share**。
7. 复制该 Shared Drive/文件夹 URL 里的 **文件夹 ID**：
   - URL 形如 `https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQr...`
   - `folders/` 后面那一长串 `1AbCdEfGh...` 才是文件夹 ID。
   - ⚠️ **不要**填文件夹的名字（例如 `MBBSExports`）——名字不是 ID，会报 `File not found`。

---

## 步骤 5：在应用里填文件夹 ID

1. 打开你的 MBBS Revision，进入 **Settings（设置）**。
2. 找到 **☁️ Google Drive 上传** 一栏。
3. 如果这一步显示 `✅ 已检测到 service account 凭据`，说明第 3 步的文件放对了。
4. 把第 4 步的 **Shared Drive 文件夹 ID** 填进「Google Drive 文件夹 ID」。
5. 点 **保存设置**。

## 步骤 6：验证

1. 打开任意一个已生成的课程。
2. 点右上角 **☁️ Drive** 按钮。
3. 看到 `已上传到 Google Drive ✓` 就成功了。
4. 去 Shared Drive 对应文件夹里确认 PDF 在不在。

如果看到报错，见下面的**排查**。

---

## 命令行替代方案（也可以用 gcloud 快速创建）

如果不想点网页，装了 Google Cloud SDK 的话可以：

```bash
gcloud auth login
gcloud projects create mbbs-drive-upload
gcloud config set project mbbs-drive-upload
gcloud iam service-accounts create mbbs-drive-upload \
  --display-name "MBBS Drive Upload"
gcloud iam service-accounts keys create data/google-service-account.json \
  --iam-account mbbs-drive-upload@mbbs-drive-upload.iam.gserviceaccount.com
```

> 之后照常做第 4、5、6 步（把文件夹共享给那个 service account 邮箱）。

---

## 常见问题排查

| 现象 | 原因 / 解决 |
|---|---|
| `Google service account not configured` | `data/google-service-account.json` 不存在或路径不对。检查文件名和位置。 |
| `403 / access denied` 上传失败 | 该 service account 没有访问这个文件夹的权限。回到第 4 步把 Shared Drive 共享给它，等几秒再试。 |
| `File not found: <名字>` | 文件夹 ID 填成了**名字**。要填 `folders/` 后面那串字母数字 ID，而不是名称。 |
| `Service Accounts do not have storage quota` | 传到了 My Drive / 根目录。Service Account 没有个人配额，**必须传到 Shared Drive**（并把 ID 填对）。 |
| Settings 里显示"未检测到凭据" | 文件没放在正确路径，或文件名不是 `google-service-account.json`。 |
| 上传成功但文件找不到 | 文件夹 ID 填错 / 传到了别的 Shared Drive；去对的地方搜文件名。 |

---

## 安全性

- Service Account JSON 是**密钥**，不要提交进 git、不要打进 Docker 镜像（`data/` 已忽略）。
- 它的权限只限于你共享给它的那些文件夹（用的是 `drive.file` scope），不能读你 Drive 里其他内容。
- 前端 / 浏览器 / API 响应里都不会包含这份 JSON 或其中的 private key。
