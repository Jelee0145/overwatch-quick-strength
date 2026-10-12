Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$taskBase = Split-Path -Parent $PSScriptRoot
$form = New-Object System.Windows.Forms.Form
$form.Text = '快速强度图 · 设置云端管理员密码'
$form.Size = New-Object System.Drawing.Size(440,300)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$label = New-Object System.Windows.Forms.Label
$label.Text = '管理员密码（10—128字符，仅保存散列）'
$label.Location = New-Object System.Drawing.Point(24,24)
$label.Size = New-Object System.Drawing.Size(380,24)
$first = New-Object System.Windows.Forms.TextBox
$first.Location = New-Object System.Drawing.Point(24,54)
$first.Size = New-Object System.Drawing.Size(372,28)
$first.UseSystemPasswordChar = $true
$confirmLabel = New-Object System.Windows.Forms.Label
$confirmLabel.Text = '再次输入确认'
$confirmLabel.Location = New-Object System.Drawing.Point(24,94)
$confirmLabel.Size = New-Object System.Drawing.Size(360,24)
$second = New-Object System.Windows.Forms.TextBox
$second.Location = New-Object System.Drawing.Point(24,122)
$second.Size = New-Object System.Drawing.Size(372,28)
$second.UseSystemPasswordChar = $true
$message = New-Object System.Windows.Forms.Label
$message.Text = '确认后配置云端密钥；密码不写入聊天或日志。'
$message.Location = New-Object System.Drawing.Point(24,160)
$message.Size = New-Object System.Drawing.Size(372,35)
$ok = New-Object System.Windows.Forms.Button
$ok.Text = '确认并配置'
$ok.Location = New-Object System.Drawing.Point(240,205)
$ok.Size = New-Object System.Drawing.Size(156,32)
$ok.Add_Click({
 if ($first.Text.Length -lt 10 -or $first.Text.Length -gt 128) { $message.Text = '密码需为10—128字符'; return }
 if ($first.Text -ne $second.Text) { $message.Text = '两次输入不一致'; return }
 $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
 $form.Close()
})
$form.Controls.AddRange(@($label,$first,$confirmLabel,$second,$message,$ok))
$form.AcceptButton = $ok
if ($form.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
 $taskStart = New-Object System.Diagnostics.ProcessStartInfo
 $taskStart.FileName = 'C:\Program Files\nodejs\node.exe'
 $taskStart.Arguments = '"' + (Join-Path $PSScriptRoot 'provision.mjs') + '"'
 $taskStart.WorkingDirectory = $taskBase
 $taskStart.UseShellExecute = $false
 $taskStart.CreateNoWindow = $true
 $taskStart.RedirectStandardInput = $true
 $taskStart.RedirectStandardOutput = $true
 $taskStart.RedirectStandardError = $true
 $process = [System.Diagnostics.Process]::Start($taskStart)
 $process.StandardInput.Write($first.Text)
 $process.StandardInput.Close()
 $first.Clear(); $second.Clear()
 $process.WaitForExit()
 $doneMessage = if ($process.ExitCode -eq 0) { '管理员密码和云端密钥已配置，可以关闭此窗口。' } else { '配置未完成，请回到Codex查看后续处理。' }
 [System.Windows.Forms.MessageBox]::Show($doneMessage,'快速强度图') | Out-Null
} else {
 $first.Clear(); $second.Clear()
}
$form.Dispose()
