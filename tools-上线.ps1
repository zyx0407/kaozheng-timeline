# 上线脚本：从凭据管理器取令牌 → 建仓库 → 推代码 → 开 Pages → 绑域名
# 用法：powershell -ExecutionPolicy Bypass -File tools-上线.ps1
$ErrorActionPreference = 'Stop'

$code = @'
using System;
using System.Runtime.InteropServices;
public class CredMan3 {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr buffer);
  [StructLayout(LayoutKind.Sequential)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public IntPtr TargetAlias; public IntPtr UserName;
  }
  public static string Get(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return null;
    CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
    string pass = Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2);
    CredFree(p);
    return pass;
  }
}
'@
Add-Type -TypeDefinition $code

$tok = [CredMan3]::Get('git:https://github.com')
if (-not $tok) { throw '没取到 GitHub 凭据' }
$H = @{ Authorization = "Bearer $tok"; 'User-Agent' = 'kz-deploy'; Accept = 'application/vnd.github+json' }
$OWNER = 'zyx0407'
$REPO = 'kaozheng-timeline'

Write-Host "== 1. 建仓库 ==" -ForegroundColor Cyan
$exists = $false
try { Invoke-RestMethod -Uri "https://api.github.com/repos/$OWNER/$REPO" -Headers $H -TimeoutSec 20 | Out-Null; $exists = $true } catch { }
if ($exists) {
  Write-Host "  仓库已存在，跳过创建"
} else {
  $body = @{
    name = $REPO
    description = '大学生考证时间轴：45 证 / 7 类，月份轴 + 卡片 + 筛选 + 进度标记 + 卡片二维码（纯静态、零依赖）'
    private = $false; has_issues = $true; has_wiki = $false; auto_init = $false
  } | ConvertTo-Json
  $repo = Invoke-RestMethod -Method Post -Uri 'https://api.github.com/user/repos' -Headers $H -Body $body -ContentType 'application/json' -TimeoutSec 30
  Write-Host "  已创建: $($repo.full_name)"
}

Write-Host "== 2. 推代码 ==" -ForegroundColor Cyan
$ErrorActionPreference = 'Continue'      # git 往 stderr 写正常进度，别让它当致命错误
& git push -u origin main 2>&1 | ForEach-Object { "  $_" }
$ErrorActionPreference = 'Stop'
$remoteHead = ((& git ls-remote origin refs/heads/main 2>$null) -replace '\s.*','').Trim()
$localHead = (& git rev-parse HEAD).Trim()
if ($remoteHead -ne $localHead) { throw "git push 没成功：远端 $remoteHead ≠ 本地 $localHead" }
Write-Host "  远端已是最新：$remoteHead"

Write-Host "== 3. 开 Pages（分支 main / 根目录）==" -ForegroundColor Cyan
$pages = @{ source = @{ branch = 'main'; path = '/' } } | ConvertTo-Json -Depth 4
try {
  $r = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$OWNER/$REPO/pages" -Headers $H -Body $pages -ContentType 'application/json' -TimeoutSec 30
  Write-Host "  Pages: $($r.html_url)  状态=$($r.status)"
} catch {
  $detail = $_.ErrorDetails.Message
  if ($detail -match 'already') { Write-Host "  Pages 已经开过了" } else { Write-Host "  开 Pages 报错：$detail" }
}

Write-Host "== 4. 绑自定义域名 ==" -ForegroundColor Cyan
Start-Sleep -Seconds 5
$dom = @{ cname = 'work1.zyx0407.com' } | ConvertTo-Json
try {
  $r2 = Invoke-RestMethod -Method Put -Uri "https://api.github.com/repos/$OWNER/$REPO/pages" -Headers $H -Body $dom -ContentType 'application/json' -TimeoutSec 30
  Write-Host "  自定义域名: $($r2.cname)  状态=$($r2.status)"
} catch {
  Write-Host "  绑域名报错：" + $_.ErrorDetails.Message
}

Write-Host "== 5. 读回确认 ==" -ForegroundColor Cyan
$final = Invoke-RestMethod -Uri "https://api.github.com/repos/$OWNER/$REPO/pages" -Headers $H -TimeoutSec 20
"  url        = " + $final.url
"  cname      = " + $final.cname
"  status     = " + $final.status
"  html_url   = " + $final.html_url
