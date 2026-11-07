using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace VoteEnDirect
{
    [ComImport, Guid("B65AD801-ABAF-11D0-BB8B-00A0C90F2744"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
    public interface IDTExtensibility2
    {
        void OnConnection(
            [In, MarshalAs(UnmanagedType.IDispatch)] object Application,
            [In] int ConnectMode,
            [In, MarshalAs(UnmanagedType.IDispatch)] object AddInInst,
            [In, MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_VARIANT)] ref Array custom
        );
        void OnDisconnection([In] int RemoveMode, [In, MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_VARIANT)] ref Array custom);
        void OnAddInsUpdate([In, MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_VARIANT)] ref Array custom);
        void OnStartupComplete([In, MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_VARIANT)] ref Array custom);
        void OnBeginShutdown([In, MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_VARIANT)] ref Array custom);
    }

    [ComImport, Guid("000C0396-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
    public interface IRibbonExtensibility
    {
        [DispId(1)]
        string GetCustomUI(string RibbonID);
    }

    [ComVisible(true)]
    [Guid("8F4E3A21-9C1B-4D7E-A623-5E12B890C4D1")]
    [ProgId("VoteEnDirect.Addin")]
    [ClassInterface(ClassInterfaceType.AutoDual)]
    public class Connect : IDTExtensibility2, IRibbonExtensibility
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int vKey);

        [DllImport("user32.dll")]
        private static extern bool GetCursorPos(out POINT lpPoint);

        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll")]
        private static extern IntPtr WindowFromPoint(POINT Point);

        [DllImport("user32.dll")]
        private static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);

        private delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr GetModuleHandle(string lpModuleName);

        private dynamic _pptApp;
        private string _projectRoot;
        private string _logPath;
        private Timer _pollTimer;
        private IntPtr _mouseHookId = IntPtr.Zero;
        private LowLevelMouseProc _mouseProcDelegate;
        private bool _hasPendingSlideShowClick = false;
        private POINT _pendingSlideShowClickPt;
        private int _pendingGotoSlideAfterInsert = -1;
        private int _lastExportedSlide = -1;
        private int _activeVotingSlide = -1;
        private int _lastShownVoteCount = -1;
        private DateTime _lastClickUtc = DateTime.MinValue;
        private DateTime _lastStatusPollUtc = DateTime.MinValue;
        private bool _hasInitializedPresentation = false;
        private bool _hasAttemptedReopen = false;

        public Connect()
        {
            string dllDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ?? "";
            _projectRoot = Path.GetFullPath(Path.Combine(dllDir, ".."));
            _logPath = Path.Combine(_projectRoot, "addin-debug.log");
        }

        private void Log(string msg)
        {
            try
            {
                File.AppendAllText(_logPath, DateTime.Now.ToString("HH:mm:ss.fff") + " | " + msg + "\r\n");
            }
            catch { }
        }

        private static int ToOleRgb(int r, int g, int b)
        {
            return r + (g * 256) + (b * 65536);
        }

        public void OnConnection(object Application, int ConnectMode, object AddInInst, ref Array custom)
        {
            _pptApp = Application;
            Log("OnConnection called");
            EnsureViteServerRunning();
            StartInProcessPollingTimer();
        }

        public void OnDisconnection(int RemoveMode, ref Array custom)
        {
            if (_mouseHookId != IntPtr.Zero)
            {
                try { UnhookWindowsHookEx(_mouseHookId); } catch { }
                _mouseHookId = IntPtr.Zero;
            }
            if (_pollTimer != null)
            {
                _pollTimer.Stop();
                _pollTimer.Dispose();
                _pollTimer = null;
            }
            _pptApp = null;
        }

        public void OnAddInsUpdate(ref Array custom) { }

        public void OnStartupComplete(ref Array custom)
        {
            Log("OnStartupComplete called");
            StartInProcessPollingTimer();
        }

        public void OnBeginShutdown(ref Array custom)
        {
            if (_mouseHookId != IntPtr.Zero)
            {
                try { UnhookWindowsHookEx(_mouseHookId); } catch { }
                _mouseHookId = IntPtr.Zero;
            }
            if (_pollTimer != null)
            {
                _pollTimer.Stop();
            }
        }

        private IntPtr MouseHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            try
            {
                if (nCode >= 0 && (int)wParam == 0x0202) // WM_LBUTTONUP (après relâchement du clic)
                {
                    POINT pt;
                    if (GetCursorPos(out pt))
                    {
                        _pendingSlideShowClickPt = pt;
                        _hasPendingSlideShowClick = true;
                    }
                }
            }
            catch { }
            return CallNextHookEx(_mouseHookId, nCode, wParam, lParam);
        }

        private void StartInProcessPollingTimer()
        {
            if (_pollTimer != null) return;
            try
            {
                _mouseProcDelegate = new LowLevelMouseProc(MouseHookCallback);
                using (Process curProcess = Process.GetCurrentProcess())
                using (ProcessModule curModule = curProcess.MainModule)
                {
                    _mouseHookId = SetWindowsHookEx(14, _mouseProcDelegate, GetModuleHandle(curModule.ModuleName), 0);
                    Log("Mouse hook installed: " + _mouseHookId);
                }
            }
            catch (Exception ex)
            {
                Log("Mouse hook err: " + ex.Message);
            }
            _pollTimer = new Timer();
            _pollTimer.Interval = 120;
            _pollTimer.Tick += OnPollTimerTick;
            _pollTimer.Start();
            Log("Polling timer started (120ms)");
        }

        private string CallLocalApi(string pathAndQuery)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://localhost:5173" + pathAndQuery);
                req.Method = "GET";
                req.Timeout = 800;
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                using (Stream stream = res.GetResponseStream())
                {
                    if (stream == null) return "";
                    using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                    {
                        return reader.ReadToEnd().Trim();
                    }
                }
            }
            catch
            {
                return "";
            }
        }

        private bool IsVotingSlide(dynamic slide)
        {
            try
            {
                bool foundVoteIndicator = false;
                int count = (int)slide.Shapes.Count;
                for (int i = 1; i <= count; i++)
                {
                    dynamic shape = slide.Shapes.Item(i);
                    string sName = (string)shape.Name ?? "";
                    if (sName == "VoteEnDirect_ResultHeader")
                    {
                        return false;
                    }
                    if (sName == "VoteEnDirect_QR" || sName.StartsWith("VoteEnDirect_BtnVote") || sName.StartsWith("btnInknoeActivity"))
                    {
                        foundVoteIndicator = true;
                    }
                    if ((int)shape.HasTextFrame == -1 && (int)shape.TextFrame.HasText == -1)
                    {
                        string txt = ((string)shape.TextFrame.TextRange.Text ?? "").ToUpperInvariant();
                        if (txt.Contains("R\u00C9SULTAT DU VOTE") || txt.Contains("RESULTAT DU VOTE"))
                        {
                            return false;
                        }
                        if (txt.Contains("VOTES :") || txt.Contains("CLASSPOINT") || txt.Contains("VOTE EN DIRECT") || txt.Contains("TEST VOTES") || txt.Contains("LANCER LE VOTE"))
                        {
                            foundVoteIndicator = true;
                        }
                    }
                }
                return foundVoteIndicator;
            }
            catch (Exception ex)
            {
                Log("IsVotingSlide err: " + ex.Message);
            }
            return false;
        }

        private void SetShapeSelfHyperlink(dynamic shape, string expectedSub)
        {
            try
            {
                dynamic act = null;
                try { act = shape.ActionSettings.Item(1); } catch { }
                if (act == null)
                {
                    try { act = shape.ActionSettings[1]; } catch { }
                }
                if (act != null)
                {
                    act.Action = 7; // ppActionHyperlink
                    act.Hyperlink.Address = "";
                    act.Hyperlink.SubAddress = expectedSub;
                }
            }
            catch (Exception ex)
            {
                Log("SetShapeSelfHyperlink err: " + ex.Message);
            }
        }

        private bool EnsureVoteElementsOnSlide(dynamic pres, dynamic slide, bool forceOnThisSlide)
        {
            bool modified = false;
            try
            {
                if (!forceOnThisSlide && !IsVotingSlide(slide))
                {
                    return false;
                }

                double slideW = (double)pres.PageSetup.SlideWidth;
                double slideH = (double)pres.PageSetup.SlideHeight;
                if (slideW <= 0) slideW = 960;
                if (slideH <= 0) slideH = 540;

                string qrFile = Path.Combine(_projectRoot, "public", "slides", "qr-session.png");
                bool hasQrFile = File.Exists(qrFile);

                dynamic labelShape = null;
                bool alreadyHasQr = false;
                bool hasIconOui = false;
                bool hasIconNon = false;
                bool hasIconAbst = false;
                dynamic oldLeftQrPic = null;
                dynamic existingBtn = null;
                dynamic existingResetBtn = null;

                int count = (int)slide.Shapes.Count;
                for (int i = count; i >= 1; i--)
                {
                    try
                    {
                        dynamic shape = slide.Shapes.Item(i);
                        string sName = (string)shape.Name ?? "";

                        // Supprimer l'ancien bouton bleu ClassPoint ("Multiple Choice") ou le bouton Vider Base sur le slide
                        if (sName.StartsWith("btnInknoeActivity") || sName.StartsWith("VoteEnDirect_BtnClearUsers"))
                        {
                            shape.Delete();
                            modified = true;
                            continue;
                        }

                        if (sName == "VoteEnDirect_QR")
                        {
                            string altTxt = "";
                            try { altTxt = (string)shape.AlternativeText ?? ""; } catch { }
                            if (altTxt == "GITHUB_PAGES_QR_V1")
                            {
                                alreadyHasQr = true;
                            }
                            else
                            {
                                oldLeftQrPic = shape;
                            }
                        }
                        else if (sName.StartsWith("VoteEnDirect_BtnVote"))
                        {
                            existingBtn = shape;
                        }
                        else if (sName.StartsWith("VoteEnDirect_BtnReset"))
                        {
                            existingResetBtn = shape;
                        }
                        else if (sName == "VoteEnDirect_IconOui")
                        {
                            hasIconOui = true;
                        }
                        else if (sName == "VoteEnDirect_IconNon")
                        {
                            hasIconNon = true;
                        }
                        else if (sName == "VoteEnDirect_IconAbst")
                        {
                            hasIconAbst = true;
                        }
                        else if ((int)shape.Type == 13 && (double)shape.Left < (slideW * 0.38) && (double)shape.Top > (slideH * 0.18) && (double)shape.Top < (slideH * 0.75) && (double)shape.Width > 70)
                        {
                            double diff = Math.Abs((double)shape.Width - (double)shape.Height);
                            if (diff < 80)
                            {
                                oldLeftQrPic = shape;
                            }
                        }

                        if ((int)shape.HasTextFrame == -1 && (int)shape.TextFrame.HasText == -1)
                        {
                            string txt = (string)shape.TextFrame.TextRange.Text ?? "";
                            if (txt.IndexOf("ClassPoint", StringComparison.OrdinalIgnoreCase) >= 0)
                            {
                                shape.TextFrame.TextRange.Text = "Vote en Direct";
                                shape.TextFrame.WordWrap = 0;
                                if ((double)shape.Width < 210) shape.Width = 210f;
                                labelShape = shape;
                                modified = true;
                            }
                            else if (txt.IndexOf("Vote en Direct", StringComparison.OrdinalIgnoreCase) >= 0)
                            {
                                shape.TextFrame.WordWrap = 0;
                                if ((double)shape.Width < 210) shape.Width = 210f;
                                labelShape = shape;
                            }
                            else if ((double)shape.Left > (slideW * 0.30) && txt.Contains("A") && txt.Contains("B") && txt.Contains("C") && txt.Trim().Length <= 60)
                            {
                                try { shape.TextFrame.AutoSize = 0; } catch { }
                                try { shape.TextFrame2.AutoSize = 0; } catch { }
                                shape.TextFrame.TextRange.Text = "";
                                shape.Top = 161.5f;
                                shape.Height = 174.5f;
                                modified = true;
                            }
                        }

                        if (!sName.StartsWith("VoteEnDirect_") && (int)shape.HasTextFrame == -1 && (double)shape.Left > 340 && (double)shape.Top > 130 && (double)shape.Top < 205 && (double)shape.Width > 400 && (double)shape.Height < 150)
                        {
                            try { shape.TextFrame.AutoSize = 0; } catch { }
                            try { shape.TextFrame2.AutoSize = 0; } catch { }
                            shape.Top = 161.5f;
                            shape.Height = 174.5f;
                            modified = true;
                        }
                    }
                    catch { }
                }

                string slidesAssetsDir = Path.Combine(_projectRoot, "public", "slides");
                string iconOuiFile = Path.Combine(slidesAssetsDir, "icon-oui.png");
                string iconNonFile = Path.Combine(slidesAssetsDir, "icon-non.png");
                string iconAbstFile = Path.Combine(slidesAssetsDir, "icon-abst.png");
                if (!hasIconOui && File.Exists(iconOuiFile))
                {
                    try
                    {
                        dynamic picOui = slide.Shapes.AddPicture(iconOuiFile, 0, -1, 471.2f, 180f, 48f, 48f);
                        picOui.Name = "VoteEnDirect_IconOui";
                        modified = true;
                    }
                    catch { }
                }
                if (!hasIconNon && File.Exists(iconNonFile))
                {
                    try
                    {
                        dynamic picNon = slide.Shapes.AddPicture(iconNonFile, 0, -1, 625.0f, 180f, 48f, 48f);
                        picNon.Name = "VoteEnDirect_IconNon";
                        modified = true;
                    }
                    catch { }
                }
                if (!hasIconAbst && File.Exists(iconAbstFile))
                {
                    try
                    {
                        dynamic picAbst = slide.Shapes.AddPicture(iconAbstFile, 0, -1, 787.7f, 180f, 48f, 48f);
                        picAbst.Name = "VoteEnDirect_IconAbst";
                        modified = true;
                    }
                    catch { }
                }

                if (hasQrFile && !alreadyHasQr)
                {
                    float qrSize = (float)Math.Round(slideH * 0.42);
                    float qrLeft = (float)Math.Round(slideW * 0.08);
                    float qrTop = (float)Math.Round(slideH * 0.29);

                    if (oldLeftQrPic != null)
                    {
                        qrLeft = (float)(double)oldLeftQrPic.Left;
                        qrTop = (float)(double)oldLeftQrPic.Top;
                        qrSize = (float)(double)oldLeftQrPic.Width;
                        try { oldLeftQrPic.Delete(); } catch { }
                    }
                    else if (labelShape != null)
                    {
                        double lLeft = (double)labelShape.Left;
                        double lTop = (double)labelShape.Top;
                        double lW = (double)labelShape.Width;
                        double lH = (double)labelShape.Height;
                        qrLeft = (float)Math.Max(30, Math.Round((lLeft + (lW / 2.0)) - (qrSize / 2.0)));
                        qrTop = (float)Math.Round(lTop + lH + 6);
                    }

                    try
                    {
                        dynamic newPic = slide.Shapes.AddPicture(qrFile, 0, -1, qrLeft, qrTop, qrSize, qrSize);
                        newPic.Name = "VoteEnDirect_QR";
                        try { newPic.AlternativeText = "GITHUB_PAGES_QR_V1"; } catch { }
                        modified = true;
                        Log("Added VoteEnDirect_QR on slide " + (int)slide.SlideIndex);
                    }
                    catch (Exception ex)
                    {
                        Log("AddPicture err: " + ex.Message);
                    }
                }

                int sId = (int)slide.SlideID;
                int sIdx = (int)slide.SlideIndex;
                string expectedSub = sId + "," + sIdx + ",VoteEnDirect";

                if (existingBtn == null)
                {
                    float btnW = (float)Math.Round(slideW * 0.42);
                    float btnH = (float)Math.Round(slideH * 0.12);
                    float btnLeft = (float)Math.Round(slideW * 0.45);
                    float btnTop = (float)Math.Round(slideH * 0.62);

                    try
                    {
                        dynamic btn = slide.Shapes.AddShape(5, btnLeft, btnTop, btnW, btnH);
                        btn.Name = "VoteEnDirect_BtnVote";
                        btn.Fill.ForeColor.RGB = ToOleRgb(16, 185, 129);
                        btn.Line.ForeColor.RGB = ToOleRgb(4, 120, 87);
                        btn.Line.Weight = 2.25f;
                        btn.TextFrame.TextRange.Text = "\u25B6 LANCER LE VOTE SUR CE SLIDE";
                        btn.TextFrame.TextRange.Font.Name = "Calibri";
                        btn.TextFrame.TextRange.Font.Size = 16;
                        btn.TextFrame.TextRange.Font.Bold = -1;
                        btn.TextFrame.TextRange.Font.Color.RGB = ToOleRgb(255, 255, 255);
                        btn.TextFrame.TextRange.ParagraphFormat.Alignment = 2;

                        SetShapeSelfHyperlink(btn, expectedSub);

                        modified = true;
                        Log("Added VoteEnDirect_BtnVote on slide " + sIdx);
                    }
                    catch (Exception ex)
                    {
                        Log("AddShape btn err: " + ex.Message);
                    }
                }
                else
                {
                    SetShapeSelfHyperlink(existingBtn, expectedSub);
                }

                float resetW = (float)Math.Round(slideW * 0.28);
                float resetH = (float)Math.Round(slideH * 0.075);
                float resetLeft = (float)Math.Round(slideW * 0.52);
                float resetTop = (float)Math.Round(slideH * 0.76);

                if (existingResetBtn == null)
                {
                    try
                    {
                        dynamic rBtn = slide.Shapes.AddShape(5, resetLeft, resetTop, resetW, resetH);
                        rBtn.Name = "VoteEnDirect_BtnReset";
                        rBtn.Fill.ForeColor.RGB = ToOleRgb(100, 116, 139);
                        rBtn.Line.ForeColor.RGB = ToOleRgb(71, 85, 105);
                        rBtn.Line.Weight = 1.5f;
                        rBtn.TextFrame.TextRange.Text = "\u21BA REMISE \u00C0 Z\u00C9RO DU VOTE";
                        rBtn.TextFrame.TextRange.Font.Name = "Calibri";
                        rBtn.TextFrame.TextRange.Font.Size = 13;
                        rBtn.TextFrame.TextRange.Font.Bold = -1;
                        rBtn.TextFrame.TextRange.Font.Color.RGB = ToOleRgb(255, 255, 255);
                        rBtn.TextFrame.TextRange.ParagraphFormat.Alignment = 2;

                        SetShapeSelfHyperlink(rBtn, expectedSub);

                        modified = true;
                        Log("Added VoteEnDirect_BtnReset on slide " + sIdx);
                    }
                    catch (Exception ex)
                    {
                        Log("AddShape reset btn err: " + ex.Message);
                    }
                }
                else
                {
                    try
                    {
                        existingResetBtn.Left = resetLeft;
                        existingResetBtn.Top = resetTop;
                        existingResetBtn.Width = resetW;
                        existingResetBtn.Height = resetH;
                        existingResetBtn.TextFrame.TextRange.Font.Size = 13;
                    }
                    catch { }
                    SetShapeSelfHyperlink(existingResetBtn, expectedSub);
                }
            }
            catch (Exception ex)
            {
                Log("EnsureVoteElementsOnSlide err: " + ex.Message);
            }
            return modified;
        }

        private void SetSlideButtonVisual(dynamic pres, int slideIndex, bool isOpen, int voteCount)
        {
            try
            {
                int total = (int)pres.Slides.Count;
                if (slideIndex < 1 || slideIndex > total) return;
                dynamic slide = pres.Slides.Item(slideIndex);
                int shCount = (int)slide.Shapes.Count;
                for (int i = 1; i <= shCount; i++)
                {
                    dynamic shape = slide.Shapes.Item(i);
                    string sName = (string)shape.Name ?? "";
                    if (sName.StartsWith("VoteEnDirect_BtnVote"))
                    {
                        if (isOpen)
                        {
                            shape.Fill.ForeColor.RGB = ToOleRgb(234, 88, 12);
                            shape.Line.ForeColor.RGB = ToOleRgb(194, 65, 12);
                            string line1 = "\u23F9 CL\u00D4TURER & AFFICHER R\u00C9SULTAT";
                            string line2 = "(" + voteCount + " vote(s) re\u00E7u(s) \u2014 Cliquez ici pour cl\u00F4turer)";
                            shape.TextFrame.TextRange.Text = line1 + "\r\n" + line2;
                            shape.TextFrame.TextRange.Font.Size = 14;
                        }
                        else
                        {
                            shape.Fill.ForeColor.RGB = ToOleRgb(16, 185, 129);
                            shape.Line.ForeColor.RGB = ToOleRgb(4, 120, 87);
                            shape.TextFrame.TextRange.Text = "\u25B6 LANCER LE VOTE SUR CE SLIDE";
                            shape.TextFrame.TextRange.Font.Size = 16;
                        }
                    }
                    else if (sName.StartsWith("VoteEnDirect_BtnReset"))
                    {
                        shape.Fill.ForeColor.RGB = ToOleRgb(100, 116, 139);
                        shape.Line.ForeColor.RGB = ToOleRgb(71, 85, 105);
                        shape.TextFrame.TextRange.Text = "\u21BA REMISE \u00C0 Z\u00C9RO DU VOTE";
                        shape.TextFrame.TextRange.Font.Size = 13;
                    }
                }

                if ((int)_pptApp.SlideShowWindows.Count > 0)
                {
                    dynamic ssView = _pptApp.SlideShowWindows.Item(1).View;
                    if ((int)ssView.CurrentShowPosition == slideIndex)
                    {
                        ssView.GotoSlide(slideIndex);
                    }
                }

                try
                {
                    string slidesDir = Path.Combine(_projectRoot, "public", "slides");
                    slide.Export(Path.Combine(slidesDir, "slide-" + slideIndex + ".png"), "PNG", 1280, 720);
                }
                catch { }
            }
            catch (Exception ex)
            {
                Log("SetSlideButtonVisual err: " + ex.Message);
            }
        }

        private void InsertResultSlideBelow(dynamic pres, int votingSlideIndex, int totalVotes, int ouiCount, int ouiPct, int nonCount, int nonPct, int abstCount, int abstPct, string sessionCode, string qTitle)
        {
            try
            {
                int total = (int)pres.Slides.Count;
                int newIdx = votingSlideIndex + 1;

                if (newIdx <= total)
                {
                    try
                    {
                        dynamic nextSlide = pres.Slides.Item(newIdx);
                        int nCount = (int)nextSlide.Shapes.Count;
                        for (int k = 1; k <= nCount; k++)
                        {
                            dynamic sh = nextSlide.Shapes.Item(k);
                            if ((int)sh.HasTextFrame == -1 && (int)sh.TextFrame.HasText == -1)
                            {
                                string t = (string)sh.TextFrame.TextRange.Text ?? "";
                                if (t.Contains("SULTAT DU VOTE"))
                                {
                                    nextSlide.Delete();
                                    break;
                                }
                            }
                        }
                    }
                    catch { }
                }

                dynamic newSlide = pres.Slides.Add(newIdx, 12);
                double slideW = (double)pres.PageSetup.SlideWidth;
                if (slideW <= 0) slideW = 960;

                if (string.IsNullOrEmpty(qTitle))
                {
                    qTitle = "Proposition soumise au vote (Diapositive " + votingSlideIndex + ")";
                }

                string dateStr = DateTime.Now.ToString("dd/MM/yyyy HH:mm");

                // 1. Bandeau Supérieur
                dynamic hdrBox = newSlide.Shapes.AddTextbox(1, 45f, 24f, (float)(slideW - 90), 90f);
                hdrBox.Name = "VoteEnDirect_ResultHeader";
                dynamic hdrRange = hdrBox.TextFrame.TextRange;
                string lineA = "R\u00C9SULTAT DU VOTE \u2014 Diapositive " + votingSlideIndex;
                string lineC = "S\u00E9ance " + sessionCode + "  \u2022  Total : " + totalVotes + " vote(s) exprim\u00E9(s)  \u2022  " + dateStr;
                hdrRange.Text = lineA + "\r\n" + qTitle + "\r\n" + lineC;
                hdrRange.Font.Name = "Calibri";
                hdrRange.Paragraphs(1).Font.Size = 24;
                hdrRange.Paragraphs(1).Font.Bold = -1;
                hdrRange.Paragraphs(1).Font.Color.RGB = ToOleRgb(15, 98, 182);
                hdrRange.Paragraphs(2).Font.Size = 16;
                hdrRange.Paragraphs(2).Font.Bold = -1;
                hdrRange.Paragraphs(2).Font.Color.RGB = ToOleRgb(15, 23, 42);
                hdrRange.Paragraphs(3).Font.Size = 12;
                hdrRange.Paragraphs(3).Font.Bold = 0;
                hdrRange.Paragraphs(3).Font.Color.RGB = ToOleRgb(100, 116, 139);

                // 2. Verdict
                string verdictText = "PROPOSITION ADOPT\u00C9E  (OUI : " + ouiPct + " %)";
                int verdictRgb = ToOleRgb(16, 185, 129);
                if (nonCount > ouiCount)
                {
                    verdictText = "PROPOSITION REJET\u00C9E  (NON : " + nonPct + " %)";
                    verdictRgb = ToOleRgb(225, 29, 72);
                }
                else if (ouiCount == nonCount)
                {
                    verdictText = "\u00C9GALIT\u00C9 DES VOIX  (OUI : " + ouiPct + " %  |  NON : " + nonPct + " %)";
                    verdictRgb = ToOleRgb(217, 119, 6);
                }

                dynamic vBanner = newSlide.Shapes.AddShape(5, 45f, 125f, (float)(slideW - 90), 52f);
                vBanner.Fill.ForeColor.RGB = verdictRgb;
                vBanner.Line.Visible = 0;
                vBanner.TextFrame.TextRange.Text = verdictText;
                vBanner.TextFrame.TextRange.Font.Name = "Calibri";
                vBanner.TextFrame.TextRange.Font.Size = 20;
                vBanner.TextFrame.TextRange.Font.Bold = -1;
                vBanner.TextFrame.TextRange.Font.Color.RGB = ToOleRgb(255, 255, 255);
                vBanner.TextFrame.TextRange.ParagraphFormat.Alignment = 2;

                // 3. Barres OUI / NON / ABSTENTION
                string[] labels = new string[] { "OUI", "NON", "ABSTENTION" };
                int[] counts = new int[] { ouiCount, nonCount, abstCount };
                int[] pcts = new int[] { ouiPct, nonPct, abstPct };
                int[] rgbs = new int[] { ToOleRgb(16, 185, 129), ToOleRgb(225, 29, 72), ToOleRgb(14, 165, 233) };

                float startY = 192f;
                float rowGap = 86f;
                float barLeft = 225f;
                float maxBarW = (float)Math.Max(260, slideW - 460);

                for (int r = 0; r < 3; r++)
                {
                    float y = startY + (r * rowGap);

                    dynamic lblShape = newSlide.Shapes.AddShape(5, 45f, y, 165f, 54f);
                    lblShape.Fill.ForeColor.RGB = rgbs[r];
                    lblShape.Line.Visible = 0;
                    lblShape.TextFrame.TextRange.Text = labels[r];
                    lblShape.TextFrame.TextRange.Font.Name = "Calibri";
                    lblShape.TextFrame.TextRange.Font.Size = 18;
                    lblShape.TextFrame.TextRange.Font.Bold = -1;
                    lblShape.TextFrame.TextRange.Font.Color.RGB = ToOleRgb(255, 255, 255);
                    lblShape.TextFrame.TextRange.ParagraphFormat.Alignment = 2;

                    dynamic trackShape = newSlide.Shapes.AddShape(5, barLeft, y + 6f, maxBarW, 42f);
                    trackShape.Fill.ForeColor.RGB = ToOleRgb(241, 245, 249);
                    trackShape.Line.ForeColor.RGB = ToOleRgb(203, 213, 225);

                    float fillW = (float)Math.Max(14, Math.Round((maxBarW * pcts[r]) / 100.0));
                    dynamic fillShape = newSlide.Shapes.AddShape(5, barLeft, y + 6f, fillW, 42f);
                    fillShape.Fill.ForeColor.RGB = rgbs[r];
                    fillShape.Line.Visible = 0;

                    dynamic scoreBox = newSlide.Shapes.AddTextbox(1, barLeft + maxBarW + 15f, y + 4f, 185f, 46f);
                    scoreBox.TextFrame.TextRange.Text = counts[r] + " voix (" + pcts[r] + " %)";
                    scoreBox.TextFrame.TextRange.Font.Name = "Calibri";
                    scoreBox.TextFrame.TextRange.Font.Size = 18;
                    scoreBox.TextFrame.TextRange.Font.Bold = -1;
                    scoreBox.TextFrame.TextRange.Font.Color.RGB = ToOleRgb(15, 23, 42);
                }

                // 4. Pied de page en bas à droite (ex: "Collège des MN – 15/11/2026") identique au modèle
                string footerText = "Coll\u00E8ge des MN \u2013 15/11/2026";
                float footerLeft = 442.5f;
                float footerTop = 479.8f;
                float footerW = 503.4f;
                float footerH = 50.9f;
                string footerFont = "Futura";
                float footerSize = 36f;
                int footerColor = ToOleRgb(3, 116, 186);

                try
                {
                    dynamic srcSlide = pres.Slides.Item(votingSlideIndex);
                    int srcCount = (int)srcSlide.Shapes.Count;
                    for (int s = 1; s <= srcCount; s++)
                    {
                        dynamic sh = srcSlide.Shapes.Item(s);
                        if ((int)sh.HasTextFrame == -1 && (int)sh.TextFrame.HasText == -1)
                        {
                            string st = ((string)sh.TextFrame.TextRange.Text ?? "").Trim();
                            if ((double)sh.Top > 430 && (st.Contains("Coll\u00E8ge") || st.Contains("202")))
                            {
                                footerText = st;
                                footerLeft = (float)(double)sh.Left;
                                footerTop = (float)(double)sh.Top;
                                footerW = (float)(double)sh.Width;
                                footerH = (float)(double)sh.Height;
                                try { footerFont = (string)sh.TextFrame.TextRange.Font.Name; } catch { }
                                try { footerSize = (float)(double)sh.TextFrame.TextRange.Font.Size; } catch { }
                                try { footerColor = (int)sh.TextFrame.TextRange.Font.Color.RGB; } catch { }
                                break;
                            }
                        }
                    }
                }
                catch { }

                dynamic footerBox = newSlide.Shapes.AddTextbox(1, footerLeft, footerTop, footerW, footerH);
                footerBox.Name = "VoteEnDirect_ResultFooter";
                footerBox.TextFrame.WordWrap = -1;
                footerBox.TextFrame.TextRange.Text = footerText;
                footerBox.TextFrame.TextRange.ParagraphFormat.Alignment = 2;
                try { footerBox.TextFrame.TextRange.Font.Name = footerFont; } catch { footerBox.TextFrame.TextRange.Font.Name = "Calibri"; }
                footerBox.TextFrame.TextRange.Font.Size = footerSize;
                footerBox.TextFrame.TextRange.Font.Bold = -1;
                footerBox.TextFrame.TextRange.Font.Color.RGB = footerColor;

                _pendingGotoSlideAfterInsert = newIdx;
                try { _pptApp.ActiveWindow.View.GotoSlide(newIdx); } catch { }
                if ((int)_pptApp.SlideShowWindows.Count > 0)
                {
                    try { _pptApp.SlideShowWindows.Item(1).View.GotoSlide(newIdx); } catch { }
                }

                try
                {
                    string slidesDir = Path.Combine(_projectRoot, "public", "slides");
                    newSlide.Export(Path.Combine(slidesDir, "slide-" + newIdx + ".png"), "PNG", 1280, 720);
                }
                catch { }
                Log("Inserted Result Slide at index " + newIdx);
            }
            catch (Exception ex)
            {
                Log("InsertResultSlideBelow err: " + ex.Message);
            }
        }

        private string CheckSlideButtonClicked(dynamic pres, int currSlide, bool inSlideShow)
        {
            try
            {
                bool hadSlideShowClick = _hasPendingSlideShowClick;
                POINT clickPt = _pendingSlideShowClickPt;
                _hasPendingSlideShowClick = false;

                DateTime now = DateTime.UtcNow;
                if ((now - _lastClickUtc).TotalMilliseconds < 1200)
                {
                    return "";
                }

                if (!inSlideShow)
                {
                    dynamic sel = _pptApp.ActiveWindow.Selection;
                    if (sel != null && ((int)sel.Type == 2 || (int)sel.Type == 3))
                    {
                        dynamic sh = null;
                        try { sh = sel.ShapeRange.Item(1); } catch { }
                        if (sh == null)
                        {
                            try { sh = sel.TextRange.Parent.Parent; } catch { }
                        }
                        if (sh != null)
                        {
                            string sName = (string)sh.Name ?? "";
                            if (sName.StartsWith("VoteEnDirect_BtnVote") || sName.StartsWith("VoteEnDirect_BtnReset") || sName.StartsWith("VoteEnDirect_BtnClearUsers"))
                            {
                                _lastClickUtc = now;
                                try { _pptApp.ActiveWindow.Selection.Unselect(); } catch { }
                                try
                                {
                                    sh.Visible = 0;
                                    sh.Visible = -1;
                                }
                                catch { }
                                try { _pptApp.ActiveWindow.View.GotoSlide(currSlide); } catch { }
                                string actionType = sName.StartsWith("VoteEnDirect_BtnClearUsers")
                                    ? "CLEAR_USERS"
                                    : (sName.StartsWith("VoteEnDirect_BtnReset") ? "RESET" : "VOTE");
                                Log("Button click (" + actionType + ") detected in Normal Mode on slide " + currSlide);
                                return actionType;
                            }
                        }
                    }
                }
                else
                {
                    if (hadSlideShowClick)
                    {
                        POINT pt = clickPt;

                        dynamic slide = pres.Slides.Item(currSlide);
                        dynamic btnVoteShape = null;
                        dynamic btnResetShape = null;
                        dynamic btnClearUsersShape = null;
                        int shCount = (int)slide.Shapes.Count;
                        for (int i = 1; i <= shCount; i++)
                        {
                            dynamic shape = slide.Shapes.Item(i);
                            string sName = (string)shape.Name ?? "";
                            if (sName.StartsWith("VoteEnDirect_BtnVote"))
                            {
                                btnVoteShape = shape;
                            }
                            else if (sName.StartsWith("VoteEnDirect_BtnReset"))
                            {
                                btnResetShape = shape;
                            }
                            else if (sName.StartsWith("VoteEnDirect_BtnClearUsers"))
                            {
                                btnClearUsersShape = shape;
                            }
                        }

                        double slideW = (double)pres.PageSetup.SlideWidth;
                        double slideH = (double)pres.PageSetup.SlideHeight;
                        if (slideW <= 0) slideW = 960;
                        if (slideH <= 0) slideH = 540;

                        RECT rect;
                        IntPtr targetHwnd = WindowFromPoint(pt);
                        if (targetHwnd != IntPtr.Zero && GetWindowRect(targetHwnd, out rect))
                        {
                            if ((rect.Right - rect.Left) < 300 || (rect.Bottom - rect.Top) < 200)
                            {
                                IntPtr rootHwnd = GetAncestor(targetHwnd, 2);
                                if (rootHwnd != IntPtr.Zero) GetWindowRect(rootHwnd, out rect);
                            }

                            double winW = rect.Right - rect.Left;
                            double winH = rect.Bottom - rect.Top;
                            if (winW > 100 && winH > 100)
                            {
                                double relX = (pt.X - rect.Left) / winW;
                                double relY = (pt.Y - rect.Top) / winH;
                                Log("SlideShow click on slide " + currSlide + " at relX=" + relX.ToString("F2") + " relY=" + relY.ToString("F2"));

                                if (btnVoteShape != null)
                                {
                                    double minX = ((double)btnVoteShape.Left / slideW) - 0.04;
                                    double maxX = (((double)btnVoteShape.Left + (double)btnVoteShape.Width) / slideW) + 0.04;
                                    double minY = ((double)btnVoteShape.Top / slideH) - 0.04;
                                    double maxY = (((double)btnVoteShape.Top + (double)btnVoteShape.Height) / slideH) + 0.04;
                                    if (relX >= minX && relX <= maxX && relY >= minY && relY <= maxY)
                                    {
                                        _lastClickUtc = now;
                                        Log("Button click (VOTE) detected in SlideShow Mode on slide " + currSlide);
                                        return "VOTE";
                                    }
                                }

                                if (btnResetShape != null)
                                {
                                    double minX = ((double)btnResetShape.Left / slideW) - 0.02;
                                    double maxX = (((double)btnResetShape.Left + (double)btnResetShape.Width) / slideW) + 0.02;
                                    double minY = ((double)btnResetShape.Top / slideH) - 0.03;
                                    double maxY = (((double)btnResetShape.Top + (double)btnResetShape.Height) / slideH) + 0.03;
                                    if (relX >= minX && relX <= maxX && relY >= minY && relY <= maxY)
                                    {
                                        _lastClickUtc = now;
                                        Log("Button click (RESET) detected in SlideShow Mode on slide " + currSlide);
                                        return "RESET";
                                    }
                                }

                                if (btnClearUsersShape != null)
                                {
                                    double minX = ((double)btnClearUsersShape.Left / slideW) - 0.02;
                                    double maxX = (((double)btnClearUsersShape.Left + (double)btnClearUsersShape.Width) / slideW) + 0.02;
                                    double minY = ((double)btnClearUsersShape.Top / slideH) - 0.03;
                                    double maxY = (((double)btnClearUsersShape.Top + (double)btnClearUsersShape.Height) / slideH) + 0.03;
                                    if (relX >= minX && relX <= maxX && relY >= minY && relY <= maxY)
                                    {
                                        _lastClickUtc = now;
                                        Log("Button click (CLEAR_USERS) detected in SlideShow Mode on slide " + currSlide);
                                        return "CLEAR_USERS";
                                    }
                                }
                            }
                        }
                    }
                }
            }
            catch { }
            return "";
        }

        private void HandleClearParticipantsOnSlide(dynamic pres, int slideNum)
        {
            try
            {
                string resp = CallLocalApi("/api/ppt-action?op=clear_participants");
                Log("HandleClearParticipantsOnSlide(" + slideNum + ") -> " + resp);

                dynamic currSlideObj = pres.Slides.Item(slideNum);
                int shCount = (int)currSlideObj.Shapes.Count;
                for (int i = 1; i <= shCount; i++)
                {
                    dynamic shape = currSlideObj.Shapes.Item(i);
                    string sName = (string)shape.Name ?? "";
                    if (sName.StartsWith("VoteEnDirect_BtnClearUsers"))
                    {
                        shape.Fill.ForeColor.RGB = ToOleRgb(16, 185, 129);
                        shape.Line.ForeColor.RGB = ToOleRgb(4, 120, 87);
                        shape.TextFrame.TextRange.Text = "\u2713 BASE VOTANTS VID\u00C9E !";
                    }
                }

                try
                {
                    string slidesDir = Path.Combine(_projectRoot, "public", "slides");
                    if (!Directory.Exists(slidesDir)) Directory.CreateDirectory(slidesDir);
                    currSlideObj.Export(Path.Combine(slidesDir, "slide-" + slideNum + ".png"), "PNG", 1280, 720);
                }
                catch { }
            }
            catch (Exception ex)
            {
                Log("HandleClearParticipantsOnSlide err: " + ex.Message);
            }
        }

        private void HandleResetVoteOnSlide(dynamic pres, int slideNum)
        {
            try
            {
                string resp = CallLocalApi("/api/ppt-action?op=reset&slide=" + slideNum);
                Log("HandleResetVoteOnSlide(" + slideNum + ") -> " + resp);

                _activeVotingSlide = -1;
                _lastShownVoteCount = -1;
                SetSlideButtonVisual(pres, slideNum, false, 0);

                // Supprimer la diapositive de résultat juste en dessous si elle existe
                int nextIdx = slideNum + 1;
                if (nextIdx <= (int)pres.Slides.Count)
                {
                    dynamic nextSlide = pres.Slides.Item(nextIdx);
                    int nShCount = (int)nextSlide.Shapes.Count;
                    for (int i = 1; i <= nShCount; i++)
                    {
                        dynamic sh = nextSlide.Shapes.Item(i);
                        string shName = (string)sh.Name ?? "";
                        string shTxt = "";
                        try
                        {
                            if ((int)sh.HasTextFrame == -1 && (int)sh.TextFrame.HasText == -1)
                            {
                                shTxt = (string)sh.TextFrame.TextRange.Text ?? "";
                            }
                        }
                        catch { }
                        if (shName == "VoteEnDirect_ResultHeader" || shTxt.Contains("SULTAT DU VOTE"))
                        {
                            nextSlide.Delete();
                            Log("Deleted Result Slide at index " + nextIdx + " during reset");
                            break;
                        }
                    }
                }

                // Indiquer visuellement sur le bouton que le vote est remis à zéro
                dynamic currSlideObj = pres.Slides.Item(slideNum);
                int shCount = (int)currSlideObj.Shapes.Count;
                for (int i = 1; i <= shCount; i++)
                {
                    dynamic shape = currSlideObj.Shapes.Item(i);
                    string sName = (string)shape.Name ?? "";
                    if (sName.StartsWith("VoteEnDirect_BtnReset"))
                    {
                        shape.Fill.ForeColor.RGB = ToOleRgb(14, 116, 144);
                        shape.Line.ForeColor.RGB = ToOleRgb(21, 94, 117);
                        shape.TextFrame.TextRange.Text = "\u2713 VOTE REMIS \u00C0 Z\u00C9RO (0)";
                    }
                }

                try
                {
                    string slidesDir = Path.Combine(_projectRoot, "public", "slides");
                    if (!Directory.Exists(slidesDir)) Directory.CreateDirectory(slidesDir);
                    currSlideObj.Export(Path.Combine(slidesDir, "slide-" + slideNum + ".png"), "PNG", 1280, 720);
                }
                catch { }
            }
            catch (Exception ex)
            {
                Log("HandleResetVoteOnSlide err: " + ex.Message);
            }
        }

        private void HandleToggleVoteOnSlide(dynamic pres, int slideNum, string slideTitle)
        {
            try
            {
                EnsureVoteElementsOnSlide(pres, pres.Slides.Item(slideNum), true);
                try
                {
                    string slidesDir = Path.Combine(_projectRoot, "public", "slides");
                    if (!Directory.Exists(slidesDir)) Directory.CreateDirectory(slidesDir);
                    pres.Slides.Item(slideNum).Export(Path.Combine(slidesDir, "slide-" + slideNum + ".png"), "PNG", 1280, 720);
                }
                catch { }

                string encodedTitle = Uri.EscapeDataString(slideTitle ?? "");
                string resp = CallLocalApi("/api/ppt-action?op=click&slide=" + slideNum + "&title=" + encodedTitle);
                Log("HandleToggleVoteOnSlide(" + slideNum + ") -> " + resp);

                if (resp.StartsWith("OPENED|"))
                {
                    _activeVotingSlide = slideNum;
                    _lastShownVoteCount = 0;
                    SetSlideButtonVisual(pres, slideNum, true, 0);
                }
                else if (resp.StartsWith("CLOSED_INSERT|"))
                {
                    _activeVotingSlide = -1;
                    _lastShownVoteCount = -1;
                    SetSlideButtonVisual(pres, slideNum, false, 0);

                    string[] parts = resp.Split('|');
                    if (parts.Length >= 10)
                    {
                        int totalVotes = int.Parse(parts[1]);
                        int ouiCount = int.Parse(parts[2]);
                        int ouiPct = int.Parse(parts[3]);
                        int nonCount = int.Parse(parts[4]);
                        int nonPct = int.Parse(parts[5]);
                        int abstCount = int.Parse(parts[6]);
                        int abstPct = int.Parse(parts[7]);
                        string sCode = parts[8];
                        string qTitle = parts[9];
                        InsertResultSlideBelow(pres, slideNum, totalVotes, ouiCount, ouiPct, nonCount, nonPct, abstCount, abstPct, sCode, qTitle);
                    }
                }
            }
            catch (Exception ex)
            {
                Log("HandleToggleVoteOnSlide err: " + ex.Message);
            }
        }

        private void EnsurePresentationWritable(ref dynamic pres)
        {
            try
            {
                if ((int)_pptApp.ProtectedViewWindows.Count > 0)
                {
                    _pptApp.ProtectedViewWindows.Item(1).Edit();
                    pres = _pptApp.ActivePresentation;
                    Log("Exited ProtectedView via Edit()");
                }
            }
            catch { }

            try
            {
                if ((bool)pres.Final)
                {
                    pres.Final = false;
                    Log("Unset pres.Final");
                }
            }
            catch { }

            try
            {
                if ((int)pres.ReadOnly != 0 && !_hasAttemptedReopen)
                {
                    _hasAttemptedReopen = true;
                    string fullPath = (string)pres.FullName;
                    if (!string.IsNullOrEmpty(fullPath) && File.Exists(fullPath))
                    {
                        Log("Presentation is ReadOnly, reopening in Read-Write mode: " + fullPath);
                        string dir = Path.GetDirectoryName(fullPath) ?? "";
                        string name = Path.GetFileName(fullPath) ?? "";
                        string lockFile = Path.Combine(dir, "~$" + name);
                        try { if (File.Exists(lockFile)) File.Delete(lockFile); } catch { }

                        pres.Close();
                        pres = _pptApp.Presentations.Open(fullPath, 0, 0, -1);
                        Log("Reopened presentation ReadOnly=" + (int)pres.ReadOnly);
                    }
                }
            }
            catch (Exception ex)
            {
                Log("EnsurePresentationWritable err: " + ex.Message);
            }
        }

        private void OnPollTimerTick(object sender, EventArgs e)
        {
            try
            {
                if (_pptApp == null) return;
                if ((int)_pptApp.ProtectedViewWindows.Count > 0)
                {
                    try { _pptApp.ProtectedViewWindows.Item(1).Edit(); } catch { }
                }
                if ((int)_pptApp.Presentations.Count <= 0) return;
                dynamic pres = _pptApp.ActivePresentation;
                EnsurePresentationWritable(ref pres);
                int totalSlides = (int)pres.Slides.Count;
                if (totalSlides < 1) return;

                if (!_hasInitializedPresentation)
                {
                    _hasInitializedPresentation = true;
                    Log("Initializing presentation (" + totalSlides + " slides)");
                    int firstVoteSlide = -1;
                    for (int i = 1; i <= totalSlides; i++)
                    {
                        dynamic s = pres.Slides.Item(i);
                        if (IsVotingSlide(s))
                        {
                            EnsureVoteElementsOnSlide(pres, s, true);
                            SetSlideButtonVisual(pres, i, false, 0);
                            if (firstVoteSlide == -1) firstVoteSlide = i;
                        }
                    }
                    if (firstVoteSlide > 0)
                    {
                        try
                        {
                            int targetInitSlide = totalSlides >= 10 ? 10 : firstVoteSlide;
                            _pptApp.ActiveWindow.View.GotoSlide(targetInitSlide);
                            Log("Navigated to voting slide: " + targetInitSlide);
                        }
                        catch { }
                    }
                    try
                    {
                        dynamic sel = _pptApp.ActiveWindow.Selection;
                        if (sel != null) sel.Unselect();
                    }
                    catch { }
                }

                bool inSlideShow = (int)_pptApp.SlideShowWindows.Count > 0;
                if (_pendingGotoSlideAfterInsert > 0 && _pendingGotoSlideAfterInsert <= totalSlides)
                {
                    int targetAfterInsert = _pendingGotoSlideAfterInsert;
                    _pendingGotoSlideAfterInsert = -1;
                    try { _pptApp.ActiveWindow.View.GotoSlide(targetAfterInsert); } catch { }
                    if (inSlideShow)
                    {
                        try { _pptApp.SlideShowWindows.Item(1).View.GotoSlide(targetAfterInsert); } catch { }
                    }
                    Log("Auto-advanced to Result Slide " + targetAfterInsert);
                }
                int currSlide = 1;
                if (inSlideShow)
                {
                    currSlide = (int)_pptApp.SlideShowWindows.Item(1).View.CurrentShowPosition;
                }
                else
                {
                    currSlide = (int)_pptApp.ActiveWindow.View.Slide.SlideIndex;
                }
                if (currSlide < 1) currSlide = 1;
                if (currSlide > totalSlides) currSlide = totalSlides;

                // 1. Vérifier immédiatement si le bouton intégré dans le slide a été cliqué
                string clickedAction = CheckSlideButtonClicked(pres, currSlide, inSlideShow);
                if (clickedAction == "VOTE")
                {
                    int sNum;
                    string sTitle;
                    GetActiveSlideInfo(out sNum, out sTitle);
                    HandleToggleVoteOnSlide(pres, currSlide, sTitle);
                    return;
                }
                else if (clickedAction == "RESET")
                {
                    HandleResetVoteOnSlide(pres, currSlide);
                    return;
                }
                else if (clickedAction == "CLEAR_USERS")
                {
                    HandleClearParticipantsOnSlide(pres, currSlide);
                    return;
                }

                // 2. Si on change de slide, exporter uniquement ce slide et vérifier ses éléments de vote
                if (_lastExportedSlide != currSlide)
                {
                    _lastExportedSlide = currSlide;
                    dynamic sObj = pres.Slides.Item(currSlide);
                    EnsureVoteElementsOnSlide(pres, sObj, false);
                    if (_activeVotingSlide != currSlide)
                    {
                        SetSlideButtonVisual(pres, currSlide, false, 0);
                    }
                    try
                    {
                        string slidesDir = Path.Combine(_projectRoot, "public", "slides");
                        if (!Directory.Exists(slidesDir)) Directory.CreateDirectory(slidesDir);
                        sObj.Export(Path.Combine(slidesDir, "slide-" + currSlide + ".png"), "PNG", 1280, 720);
                    }
                    catch { }
                    CallLocalApi("/api/ppt-action?op=slide&slide=" + currSlide);
                }

                // 3. Synchronisation régulière avec le serveur local (compteur de votes + commandes)
                if ((DateTime.UtcNow - _lastStatusPollUtc).TotalMilliseconds >= 500)
                {
                    _lastStatusPollUtc = DateTime.UtcNow;
                    string stResp = CallLocalApi("/api/ppt-action?op=status&slide=" + currSlide);
                    if (stResp.StartsWith("CMD|"))
                    {
                        string cmd = stResp.Substring(4);
                        Log("Received CMD: " + cmd);
                        if (cmd.StartsWith("GOTO:"))
                        {
                            int target = int.Parse(cmd.Substring(5));
                            if (inSlideShow) _pptApp.SlideShowWindows.Item(1).View.GotoSlide(target);
                            else _pptApp.ActiveWindow.View.GotoSlide(target);
                            _lastExportedSlide = -1;
                        }
                        else if (cmd == "CLICK_BTN")
                        {
                            int sNum;
                            string sTitle;
                            GetActiveSlideInfo(out sNum, out sTitle);
                            HandleToggleVoteOnSlide(pres, currSlide, sTitle);
                        }
                        else if (cmd == "CLICK_RESET")
                        {
                            HandleResetVoteOnSlide(pres, currSlide);
                        }
                        else if (cmd == "CLICK_CLEAR_USERS")
                        {
                            HandleClearParticipantsOnSlide(pres, currSlide);
                        }
                        else if (cmd.StartsWith("DELETE_SLIDE:"))
                        {
                            int delIdx = int.Parse(cmd.Substring(13));
                            if (delIdx >= 1 && delIdx <= (int)pres.Slides.Count)
                            {
                                pres.Slides.Item(delIdx).Delete();
                                Log("Deleted slide " + delIdx);
                            }
                        }
                        else if (cmd == "SAVE_PRES")
                        {
                            pres.Save();
                            Log("Saved presentation");
                        }
                    }
                    else if (_activeVotingSlide == currSlide && stResp.StartsWith("OPEN|"))
                    {
                        string[] parts = stResp.Split('|');
                        if (parts.Length >= 2)
                        {
                            int vCount = int.Parse(parts[1]);
                            if (vCount != _lastShownVoteCount)
                            {
                                _lastShownVoteCount = vCount;
                                SetSlideButtonVisual(pres, currSlide, true, vCount);
                            }
                        }
                    }
                }
            }
            catch { }
        }

        public string GetCustomUI(string RibbonID)
        {
            return @"<customUI xmlns=""http://schemas.microsoft.com/office/2009/07/customui"">
  <ribbon>
    <tabs>
      <tab id=""TabVoteEnDirect"" label=""Vote en Direct"" insertAfterMso=""TabHome"">
        <group id=""GrpConnexion"" label=""1. Connexion des Votants"">
          <button id=""BtnQrCode""
                  label=""Intégrer QR &amp; Bouton dans ce Slide""
                  size=""large""
                  imageMso=""AddressBook""
                  screentip=""Intégrer le QR Code et le bouton de vote directement dans cette diapositive""
                  supertip=""Ajoute le QR Code de la séance et le bouton LANCER LE VOTE directement dans la diapositive affichée.""
                  onAction=""OnClickQrCode"" />
          <button id=""BtnListVotants""
                  label=""Codes Votants (4 chiffres)""
                  size=""large""
                  imageMso=""FindDialog""
                  screentip=""Voir la liste des participants connectés et leurs codes personnels à 4 chiffres""
                  supertip=""Affiche tous les participants inscrits et leur code à 4 chiffres (#XXXX) en cas d'oubli.""
                  onAction=""OnClickListVotants"" />
          <button id=""BtnClearVotants""
                  label=""Vider la Base des Votants""
                  size=""large""
                  imageMso=""Delete""
                  screentip=""Réinitialiser la liste des participants connectés et leurs codes à 4 chiffres""
                  supertip=""Vide la base des participants connectés pour permettre à tous de se reconnecter à zéro.""
                  onAction=""OnClickClearVotants"" />
        </group>
        <group id=""GrpScrutin"" label=""2. Vote du Texte (OUI / NON / ABSTENTION)"">
          <button id=""BtnVoteSlide""
                  label=""Lancer / Clôturer le Vote sur ce Slide""
                  size=""large""
                  imageMso=""AcceptInvitation""
                  screentip=""Lancer ou clôturer le vote OUI / NON / ABSTENTION sur cette diapositive""
                  supertip=""1er clic : ouvre le vote sur les téléphones. 2e clic : clôture le vote et insère la diapositive de résultats juste en dessous.""
                  onAction=""OnClickVoteSlide"" />
        </group>
        <group id=""GrpPV"" label=""3. Procès-Verbal &amp; Résultats"">
          <button id=""BtnResultats""
                  label=""Procès-Verbal &amp; Export CSV""
                  size=""large""
                  imageMso=""ExportExcel""
                  screentip=""Voir l'historique des votes et exporter en Excel/CSV""
                  supertip=""Ouvre le tableau récapitulatif de tous les textes votés (ADOPTÉ / REJETÉ) et télécharge le fichier CSV.""
                  onAction=""OnClickHistory"" />
        </group>
      </tab>
    </tabs>
  </ribbon>
</customUI>";
        }

        private void GetActiveSlideInfo(out int slideNumber, out string slideTitle)
        {
            slideNumber = 1;
            slideTitle = "";
            try
            {
                if (_pptApp == null || (int)_pptApp.Presentations.Count <= 0) return;

                dynamic pres = _pptApp.ActivePresentation;
                int ssCount = (int)_pptApp.SlideShowWindows.Count;
                if (ssCount > 0)
                {
                    slideNumber = (int)_pptApp.SlideShowWindows.Item(1).View.CurrentShowPosition;
                }
                else
                {
                    slideNumber = (int)_pptApp.ActiveWindow.View.Slide.SlideIndex;
                }

                dynamic slide = pres.Slides.Item(slideNumber);
                if ((int)slide.Shapes.HasTitle == -1)
                {
                    slideTitle = (string)slide.Shapes.Title.TextFrame.TextRange.Text;
                }
                else
                {
                    int shCount = (int)slide.Shapes.Count;
                    for (int i = 1; i <= shCount; i++)
                    {
                        dynamic shape = slide.Shapes.Item(i);
                        string sName = (string)shape.Name ?? "";
                        if (sName.StartsWith("VoteEnDirect_")) continue;
                        if ((int)shape.HasTextFrame == -1 && (int)shape.TextFrame.HasText == -1)
                        {
                            string txt = ((string)shape.TextFrame.TextRange.Text ?? "").Trim();
                            if (txt.Length > 0)
                            {
                                slideTitle = txt;
                                break;
                            }
                        }
                    }
                }
                if (slideTitle != null)
                {
                    slideTitle = slideTitle.Replace("\r", " ").Replace("\n", " ").Trim();
                    if (slideTitle.Length > 120) slideTitle = slideTitle.Substring(0, 120) + "...";
                }
            }
            catch { }
        }

        private void EnsureViteServerRunning()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://localhost:5173");
                req.Timeout = 400;
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                {
                    return;
                }
            }
            catch
            {
                try
                {
                    string viteScript = Path.Combine(_projectRoot, "node_modules", "vite", "bin", "vite.js");
                    if (File.Exists(viteScript))
                    {
                        ProcessStartInfo psi = new ProcessStartInfo("node", "\"" + viteScript + "\"")
                        {
                            WorkingDirectory = _projectRoot,
                            CreateNoWindow = true,
                            UseShellExecute = false
                        };
                        Process.Start(psi);
                    }
                }
                catch { }
            }
        }

        private void OpenOverlayAction(string queryParams)
        {
            try
            {
                EnsureViteServerRunning();
                int slideNum;
                string slideTitle;
                GetActiveSlideInfo(out slideNum, out slideTitle);

                string encodedTitle = Uri.EscapeDataString(slideTitle ?? "");
                string url = "http://localhost:5173/?" + queryParams + "&pptSlide=" + slideNum + "&pptTitle=" + encodedTitle + "&t=" + DateTime.Now.Ticks;
                Process.Start(url);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Erreur lors de l'ouverture : " + ex.Message, "Vote en Direct");
            }
        }

        public void OnClickQrCode(object control)
        {
            try
            {
                if (_pptApp != null && (int)_pptApp.Presentations.Count > 0)
                {
                    dynamic pres = _pptApp.ActivePresentation;
                    int slideNum;
                    string slideTitle;
                    GetActiveSlideInfo(out slideNum, out slideTitle);
                    EnsureVoteElementsOnSlide(pres, pres.Slides.Item(slideNum), true);
                    SetSlideButtonVisual(pres, slideNum, false, 0);
                }
            }
            catch { }
        }

        public void OnClickListVotants(object control)
        {
            try
            {
                EnsureViteServerRunning();
                string resp = CallLocalApi("/api/ppt-action?op=list_participants");
                Log("OnClickListVotants -> " + resp);
                if (string.IsNullOrEmpty(resp) || resp == "EMPTY")
                {
                    MessageBox.Show("Aucun participant n'est actuellement inscrit dans la séance.", "Vote en Direct — Codes Votants (4 chiffres)", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                else
                {
                    MessageBox.Show("Liste des participants inscrits et leur code personnel à 4 chiffres :\r\n\r\n" + resp, "Vote en Direct — Codes Votants (4 chiffres)", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("Erreur : " + ex.Message, "Vote en Direct");
            }
        }

        public void OnClickClearVotants(object control)
        {
            try
            {
                EnsureViteServerRunning();
                string resp = CallLocalApi("/api/ppt-action?op=clear_participants");
                Log("OnClickClearVotants -> " + resp);
                if (_pptApp != null && (int)_pptApp.Presentations.Count > 0)
                {
                    dynamic pres = _pptApp.ActivePresentation;
                    int slideNum;
                    string slideTitle;
                    GetActiveSlideInfo(out slideNum, out slideTitle);
                    HandleClearParticipantsOnSlide(pres, slideNum);
                }
                MessageBox.Show("La base des votants connectés (et leurs codes à 4 chiffres) a été entièrement remise à zéro.", "Vote en Direct — Base Votants Vidée", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Erreur : " + ex.Message, "Vote en Direct");
            }
        }

        public void OnClickVoteSlide(object control)
        {
            try
            {
                if (_pptApp != null && (int)_pptApp.Presentations.Count > 0)
                {
                    dynamic pres = _pptApp.ActivePresentation;
                    int slideNum;
                    string slideTitle;
                    GetActiveSlideInfo(out slideNum, out slideTitle);
                    HandleToggleVoteOnSlide(pres, slideNum, slideTitle);
                }
            }
            catch { }
        }

        public void OnClickOverlay(object control)
        {
            OnClickVoteSlide(control);
        }

        public void OnClickHistory(object control)
        {
            OpenOverlayAction("pptAction=history");
        }
    }
}
