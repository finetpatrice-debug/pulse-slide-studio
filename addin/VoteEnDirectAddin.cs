using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using System.Xml;

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

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern IntPtr SetActiveWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern IntPtr SetFocus(IntPtr hWnd);

        private dynamic _pptApp;
        private string _projectRoot;
        private string _logPath;
        private System.Windows.Forms.Timer _pollTimer;
        private Thread _bgInputThread;
        private volatile bool _stopBgThread = false;
        private bool _wasMouseDown = false;
        private bool _wasNextKeyDown = false;
        private bool _wasPrevKeyDown = false;
        private volatile bool _hasPendingSlideShowClick = false;
        private POINT _pendingSlideShowClickPt;
        private IntPtr _lastSlideShowHwnd = IntPtr.Zero;
        private IntPtr _lastSlideShowChildHwnd = IntPtr.Zero;
        private int _pendingGotoSlideAfterInsert = -1;
        private int _pendingFocusRestoreTicks = 0;
        private volatile bool _needsRemoteAssistAfterAction = false;
        private volatile int _pendingRemoteKeyDir = 0;
        private DateTime _pendingRemoteKeyUtc = DateTime.MinValue;
        private int _lastKnownSlideShowPos = -1;
        private volatile int _activeVotingSlide = -1;
        private int _lastShownVoteCount = -1;
        private DateTime _lastClickUtc = DateTime.MinValue;
        private DateTime _lastStatusPollUtc = DateTime.MinValue;
        private DateTime _lastIdleCheckUtc = DateTime.MinValue;
        private volatile bool _hasInitializedPresentation = false;
        private string _lastPresentationKey = "";
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

        private void DisableHeavyThirdPartyAddins()
        {
            string[] progIds = new string[] { "ClassPoint2", "PDFMaker.OfficeAddin", "OneNote.PowerPointAddinTakeNotesButton" };
            foreach (string pid in progIds)
            {
                try
                {
                    dynamic ca = _pptApp.COMAddIns.Item(pid);
                    if (ca != null && (bool)ca.Connect)
                    {
                        ca.Connect = false;
                        Log("Auto-disconnected COMAddIn: " + pid);
                    }
                }
                catch { }
            }
        }

        public void OnConnection(object Application, int ConnectMode, object AddInInst, ref Array custom)
        {
            _pptApp = Application;
            Log("OnConnection called (v21)");
            DisableHeavyThirdPartyAddins();
            EnsureViteServerRunning();
            StartInProcessPollingTimer();
        }

        public void OnDisconnection(int RemoveMode, ref Array custom)
        {
            _stopBgThread = true;
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
            DisableHeavyThirdPartyAddins();
            StartInProcessPollingTimer();
        }

        public void OnBeginShutdown(ref Array custom)
        {
            _stopBgThread = true;
            try { CallLocalApi("/api/ppt-action?op=clear_participants&title=Cloture"); } catch { }
            if (_pollTimer != null)
            {
                _pollTimer.Stop();
                _pollTimer.Dispose();
                _pollTimer = null;
            }
            _pptApp = null;
        }

        private void StartInProcessPollingTimer()
        {
            if (_pollTimer == null)
            {
                _pollTimer = new System.Windows.Forms.Timer();
                _pollTimer.Interval = 220;
                _pollTimer.Tick += OnPollTimerTick;
                _pollTimer.Start();
                Log("Polling timer started (220ms zero-COM idle)");
            }
            if (_bgInputThread == null)
            {
                _stopBgThread = false;
                _bgInputThread = new Thread(BackgroundInputLoop);
                _bgInputThread.IsBackground = true;
                _bgInputThread.Start();
            }
        }

        private void BackgroundInputLoop()
        {
            while (!_stopBgThread)
            {
                try
                {
                    Thread.Sleep(25);
                    if (_stopBgThread) break;

                    // Détecter uniquement le clic gauche souris (0x01) sans jamais interroger les touches clavier/télécommande
                    bool isMouseDown = (GetAsyncKeyState(0x01) & 0x8000) != 0;
                    if (isMouseDown)
                    {
                        GetCursorPos(out _pendingSlideShowClickPt);
                        _wasMouseDown = true;
                        continue;
                    }
                    if (_wasMouseDown)
                    {
                        _wasMouseDown = false;
                        bool insideSlideArea = true;
                        try
                        {
                            System.Drawing.Rectangle scr = Screen.FromPoint(new System.Drawing.Point(_pendingSlideShowClickPt.X, _pendingSlideShowClickPt.Y)).Bounds;
                            if (scr.Width > 100 && scr.Height > 100)
                            {
                                double sRelX = (double)(_pendingSlideShowClickPt.X - scr.Left) / scr.Width;
                                double sRelY = (double)(_pendingSlideShowClickPt.Y - scr.Top) / scr.Height;
                                // Autoriser sRelX >= 0.05 (pour le Mode Présentateur à gauche) et sRelY >= 0.07 (pour réactiver le focus après bascule Paramètres d'affichage)
                                if (sRelY < 0.07 || sRelY > 0.88 || sRelX < 0.05)
                                {
                                    insideSlideArea = false;
                                }
                            }
                        }
                        catch { }

                        if (insideSlideArea)
                        {
                            _hasPendingSlideShowClick = true;
                        }
                    }

                    // Relais de sécurité pour la télécommande après insertion des résultats ou bascule d'affichage :
                    // Si PowerPoint a perdu le focus clavier, capter l'appui NEXT / PREV pour faire avancer le diaporama sans blocage.
                    if (_needsRemoteAssistAfterAction)
                    {
                        bool nextDown = ((GetAsyncKeyState(0x22) & 0x8000) != 0) || ((GetAsyncKeyState(0x27) & 0x8000) != 0) || ((GetAsyncKeyState(0x28) & 0x8000) != 0);
                        if (nextDown && !_wasNextKeyDown)
                        {
                            _wasNextKeyDown = true;
                            _pendingRemoteKeyDir = 1;
                            _pendingRemoteKeyUtc = DateTime.UtcNow;
                        }
                        else if (!nextDown)
                        {
                            _wasNextKeyDown = false;
                        }

                        bool prevDown = ((GetAsyncKeyState(0x21) & 0x8000) != 0) || ((GetAsyncKeyState(0x25) & 0x8000) != 0) || ((GetAsyncKeyState(0x26) & 0x8000) != 0);
                        if (prevDown && !_wasPrevKeyDown)
                        {
                            _wasPrevKeyDown = true;
                            _pendingRemoteKeyDir = -1;
                            _pendingRemoteKeyUtc = DateTime.UtcNow;
                        }
                        else if (!prevDown)
                        {
                            _wasPrevKeyDown = false;
                        }
                    }
                }
                catch { }
            }
        }

        private string CallLocalApi(string pathAndQuery, int timeoutMs = 250)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:5173" + pathAndQuery);
                req.Method = "GET";
                req.Timeout = timeoutMs;
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
                bool hasLblOui = false;
                bool hasLblNon = false;
                bool hasLblAbst = false;
                bool hasCounter = false;
                dynamic oldLeftQrPic = null;
                dynamic existingBtn = null;
                dynamic existingResetBtn = null;

                double scaleX = slideW / 960.0;
                float iconOuiX = (float)Math.Round(471.2 * scaleX);
                float iconNonX = (float)Math.Round(625.0 * scaleX);
                float iconAbstX = (float)Math.Round(787.7 * scaleX);

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
                            if (altTxt == "GITHUB_PAGES_QR_V2")
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
                            if ((double)shape.Left + (double)shape.Width > slideW - 10) shape.Left = iconOuiX;
                        }
                        else if (sName == "VoteEnDirect_IconNon")
                        {
                            hasIconNon = true;
                            if ((double)shape.Left + (double)shape.Width > slideW - 10) shape.Left = iconNonX;
                        }
                        else if (sName == "VoteEnDirect_IconAbst")
                        {
                            hasIconAbst = true;
                            if ((double)shape.Left + (double)shape.Width > slideW - 10) shape.Left = iconAbstX;
                        }
                        else if (sName == "VoteEnDirect_LblOui" || sName == "Tableau 32")
                        {
                            hasLblOui = true;
                        }
                        else if (sName == "VoteEnDirect_LblNon" || sName == "Tableau 34")
                        {
                            hasLblNon = true;
                        }
                        else if (sName == "VoteEnDirect_LblAbst" || sName == "Tableau 36")
                        {
                            hasLblAbst = true;
                        }
                        else if (sName == "VoteEnDirect_Counter")
                        {
                            hasCounter = true;
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
                        dynamic picOui = slide.Shapes.AddPicture(iconOuiFile, 0, -1, iconOuiX, 175f, 46f, 46f);
                        picOui.Name = "VoteEnDirect_IconOui";
                        modified = true;
                    }
                    catch { }
                }
                if (!hasIconNon && File.Exists(iconNonFile))
                {
                    try
                    {
                        dynamic picNon = slide.Shapes.AddPicture(iconNonFile, 0, -1, iconNonX, 175f, 46f, 46f);
                        picNon.Name = "VoteEnDirect_IconNon";
                        modified = true;
                    }
                    catch { }
                }
                if (!hasIconAbst && File.Exists(iconAbstFile))
                {
                    try
                    {
                        dynamic picAbst = slide.Shapes.AddPicture(iconAbstFile, 0, -1, iconAbstX, 175f, 46f, 46f);
                        picAbst.Name = "VoteEnDirect_IconAbst";
                        modified = true;
                    }
                    catch { }
                }

                // Étiquettes OUI / NON / ABST sous les sigles (déplaçables et dimensionnables)
                if (!hasLblOui)
                {
                    try
                    {
                        dynamic lblOui = slide.Shapes.AddShape(5, iconOuiX - 11f, 227f, 68f, 26f);
                        lblOui.Name = "VoteEnDirect_LblOui";
                        lblOui.Fill.ForeColor.RGB = ToOleRgb(187, 247, 208);
                        lblOui.Line.ForeColor.RGB = ToOleRgb(34, 197, 94);
                        lblOui.Line.Weight = 1.25f;
                        lblOui.TextFrame.WordWrap = 0;
                        lblOui.TextFrame.MarginLeft = 2f;
                        lblOui.TextFrame.MarginRight = 2f;
                        lblOui.TextFrame.MarginTop = 1f;
                        lblOui.TextFrame.MarginBottom = 1f;
                        lblOui.TextFrame.TextRange.Text = "OUI";
                        lblOui.TextFrame.TextRange.Font.Name = "Calibri";
                        lblOui.TextFrame.TextRange.Font.Size = 13;
                        lblOui.TextFrame.TextRange.Font.Bold = -1;
                        lblOui.TextFrame.TextRange.Font.Color.RGB = ToOleRgb(15, 23, 42);
                        lblOui.TextFrame.TextRange.ParagraphFormat.Alignment = 2;
                        modified = true;
                    }
                    catch { }
                }
                if (!hasLblNon)
                {
                    try
                    {
                        dynamic lblNon = slide.Shapes.AddShape(5, iconNonX - 11f, 227f, 68f, 26f);
                        lblNon.Name = "VoteEnDirect_LblNon";
                        lblNon.Fill.ForeColor.RGB = ToOleRgb(254, 205, 211);
                        lblNon.Line.ForeColor.RGB = ToOleRgb(244, 63, 94);
                        lblNon.Line.Weight = 1.25f;
                        lblNon.TextFrame.WordWrap = 0;
                        lblNon.TextFrame.MarginLeft = 2f;
                        lblNon.TextFrame.MarginRight = 2f;
                        lblNon.TextFrame.MarginTop = 1f;
                        lblNon.TextFrame.MarginBottom = 1f;
                        lblNon.TextFrame.TextRange.Text = "NON";
                        lblNon.TextFrame.TextRange.Font.Name = "Calibri";
                        lblNon.TextFrame.TextRange.Font.Size = 13;
                        lblNon.TextFrame.TextRange.Font.Bold = -1;
                        lblNon.TextFrame.TextRange.Font.Color.RGB = ToOleRgb(15, 23, 42);
                        lblNon.TextFrame.TextRange.ParagraphFormat.Alignment = 2;
                        modified = true;
                    }
                    catch { }
                }
                if (!hasLblAbst)
                {
                    try
                    {
                        dynamic lblAbst = slide.Shapes.AddShape(5, iconAbstX - 11f, 227f, 68f, 26f);
                        lblAbst.Name = "VoteEnDirect_LblAbst";
                        lblAbst.Fill.ForeColor.RGB = ToOleRgb(186, 230, 253);
                        lblAbst.Line.ForeColor.RGB = ToOleRgb(14, 165, 233);
                        lblAbst.Line.Weight = 1.25f;
                        lblAbst.TextFrame.WordWrap = 0;
                        lblAbst.TextFrame.MarginLeft = 2f;
                        lblAbst.TextFrame.MarginRight = 2f;
                        lblAbst.TextFrame.MarginTop = 1f;
                        lblAbst.TextFrame.MarginBottom = 1f;
                        lblAbst.TextFrame.TextRange.Text = "ABST";
                        lblAbst.TextFrame.TextRange.Font.Name = "Calibri";
                        lblAbst.TextFrame.TextRange.Font.Size = 13;
                        lblAbst.TextFrame.TextRange.Font.Bold = -1;
                        lblAbst.TextFrame.TextRange.Font.Color.RGB = ToOleRgb(15, 23, 42);
                        lblAbst.TextFrame.TextRange.ParagraphFormat.Alignment = 2;
                        modified = true;
                    }
                    catch { }
                }

                // Compteur des personnes qui ont voté (déplaçable et dimensionnable)
                if (!hasCounter)
                {
                    try
                    {
                        dynamic cntBox = slide.Shapes.AddShape(5, iconOuiX - 14f, 280f, 84f, 58f);
                        cntBox.Name = "VoteEnDirect_Counter";
                        cntBox.Fill.ForeColor.RGB = ToOleRgb(255, 255, 255);
                        cntBox.Line.ForeColor.RGB = ToOleRgb(3, 116, 186);
                        cntBox.Line.Weight = 2.25f;
                        cntBox.TextFrame.WordWrap = 0;
                        cntBox.TextFrame.MarginLeft = 4f;
                        cntBox.TextFrame.MarginRight = 4f;
                        cntBox.TextFrame.MarginTop = 2f;
                        cntBox.TextFrame.MarginBottom = 2f;
                        cntBox.TextFrame.TextRange.Text = "0";
                        cntBox.TextFrame.TextRange.Font.Name = "Calibri";
                        cntBox.TextFrame.TextRange.Font.Size = 26;
                        cntBox.TextFrame.TextRange.Font.Bold = -1;
                        cntBox.TextFrame.TextRange.Font.Color.RGB = ToOleRgb(3, 116, 186);
                        cntBox.TextFrame.TextRange.ParagraphFormat.Alignment = 2;
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
                        try { newPic.AlternativeText = "GITHUB_PAGES_QR_V2"; } catch { }
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

                float btnW = 125f;
                float btnH = 38f;
                float btnLeft = (float)Math.Round(360.0 * scaleX);
                float btnTop = 390f;

                if (existingBtn == null)
                {
                    try
                    {
                        dynamic btn = slide.Shapes.AddShape(5, btnLeft, btnTop, btnW, btnH);
                        btn.Name = "VoteEnDirect_BtnVote";
                        btn.Fill.ForeColor.RGB = ToOleRgb(16, 185, 129);
                        btn.Line.ForeColor.RGB = ToOleRgb(4, 120, 87);
                        btn.Line.Weight = 1.75f;
                        btn.TextFrame.WordWrap = 0;
                        btn.TextFrame.MarginLeft = 4f;
                        btn.TextFrame.MarginRight = 4f;
                        btn.TextFrame.MarginTop = 2f;
                        btn.TextFrame.MarginBottom = 2f;
                        btn.TextFrame.TextRange.Text = "\u25B6 LANCER VOTE";
                        btn.TextFrame.TextRange.Font.Name = "Calibri";
                        btn.TextFrame.TextRange.Font.Size = 10;
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
                    try
                    {
                        // Si le bouton existant sortait de la diapositive (ou était à l'ancienne position > 55% slideW), le recadrer dans la dia
                        if ((double)existingBtn.Left + (double)existingBtn.Width > slideW - 15 || (double)existingBtn.Left > slideW * 0.50)
                        {
                            existingBtn.Left = btnLeft;
                            existingBtn.Top = btnTop;
                            existingBtn.Width = btnW;
                            existingBtn.Height = btnH;
                        }
                        string curTxt = (string)existingBtn.TextFrame.TextRange.Text ?? "";
                        if (curTxt.IndexOf("SUR CE SLIDE", StringComparison.OrdinalIgnoreCase) >= 0 || curTxt.Trim().Length == 0)
                        {
                            existingBtn.TextFrame.TextRange.Text = "\u25B6 LANCER VOTE";
                        }
                    }
                    catch { }
                    SetShapeSelfHyperlink(existingBtn, expectedSub);
                }

                float resetW = 185f;
                float resetH = 38f;
                float resetLeft = btnLeft + btnW + 10f;
                float resetTop = 390f;

                if (existingResetBtn == null)
                {
                    try
                    {
                        dynamic rBtn = slide.Shapes.AddShape(5, resetLeft, resetTop, resetW, resetH);
                        rBtn.Name = "VoteEnDirect_BtnReset";
                        rBtn.Fill.ForeColor.RGB = ToOleRgb(100, 116, 139);
                        rBtn.Line.ForeColor.RGB = ToOleRgb(71, 85, 105);
                        rBtn.Line.Weight = 1.5f;
                        rBtn.TextFrame.WordWrap = 0;
                        rBtn.TextFrame.MarginLeft = 4f;
                        rBtn.TextFrame.MarginRight = 4f;
                        rBtn.TextFrame.MarginTop = 2f;
                        rBtn.TextFrame.MarginBottom = 2f;
                        rBtn.TextFrame.TextRange.Text = "\u21BA REMISE \u00C0 Z\u00C9RO (0)";
                        rBtn.TextFrame.TextRange.Font.Name = "Calibri";
                        rBtn.TextFrame.TextRange.Font.Size = 10;
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
                        // Si le bouton Remise à zéro dépassait de la diapositive à droite, le ramener dans la dia
                        if ((double)existingResetBtn.Left + (double)existingResetBtn.Width > slideW - 15)
                        {
                            existingResetBtn.Left = resetLeft;
                            existingResetBtn.Top = resetTop;
                            existingResetBtn.Width = resetW;
                            existingResetBtn.Height = resetH;
                            existingResetBtn.TextFrame.TextRange.Font.Size = 10;
                        }
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
                        // Ne jamais écraser Left / Top / Width / Height / Font.Size pour laisser le bouton déplaçable et dimensionnable !
                        if (isOpen)
                        {
                            shape.Fill.ForeColor.RGB = ToOleRgb(234, 88, 12);
                            shape.Line.ForeColor.RGB = ToOleRgb(194, 65, 12);
                            shape.TextFrame.TextRange.Text = "\u23F9 CL\u00D4TURER (" + voteCount + ")";
                        }
                        else
                        {
                            shape.Fill.ForeColor.RGB = ToOleRgb(16, 185, 129);
                            shape.Line.ForeColor.RGB = ToOleRgb(4, 120, 87);
                            shape.TextFrame.TextRange.Text = "\u25B6 LANCER VOTE";
                        }
                    }
                    else if (sName.StartsWith("VoteEnDirect_BtnReset"))
                    {
                        // Ne jamais écraser Left / Top / Width / Height / Font.Size pour laisser le bouton déplaçable et dimensionnable !
                        shape.Fill.ForeColor.RGB = ToOleRgb(100, 116, 139);
                        shape.Line.ForeColor.RGB = ToOleRgb(71, 85, 105);
                        shape.TextFrame.TextRange.Text = "\u21BA REMISE \u00C0 Z\u00C9RO (" + voteCount + ")";
                    }
                    else if (sName == "VoteEnDirect_Counter")
                    {
                        // Mettre à jour uniquement le chiffre du compteur en conservant sa taille et sa position personnalisées
                        shape.TextFrame.TextRange.Text = voteCount.ToString();
                    }
                }

                if ((int)_pptApp.SlideShowWindows.Count > 0)
                {
                    dynamic ssWin = _pptApp.SlideShowWindows.Item(1);
                    dynamic ssView = ssWin.View;
                    if (isOpen && (int)ssView.CurrentShowPosition == slideIndex)
                    {
                        ssView.GotoSlide(slideIndex);
                    }
                    RestoreSlideShowFocus();
                }
            }
            catch (Exception ex)
            {
                Log("SetSlideButtonVisual err: " + ex.Message);
            }
        }

        private void RestoreSlideShowFocus()
        {
            try
            {
                if ((int)_pptApp.SlideShowWindows.Count > 0)
                {
                    try { _pptApp.SlideShowWindows.Item(1).Activate(); } catch { }
                }
                if (_lastSlideShowHwnd != IntPtr.Zero)
                {
                    try { SetForegroundWindow(_lastSlideShowHwnd); } catch { }
                    try { SetActiveWindow(_lastSlideShowHwnd); } catch { }
                }
                if (_lastSlideShowChildHwnd != IntPtr.Zero)
                {
                    try { SetFocus(_lastSlideShowChildHwnd); } catch { }
                }
            }
            catch { }
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

                // 1A. Titre dans le bandeau supérieur ("RÉSULTAT DU VOTE — Diapositive X")
                dynamic hdrBox = newSlide.Shapes.AddTextbox(1, 45f, 22f, (float)(slideW - 90), 42f);
                hdrBox.Name = "VoteEnDirect_ResultHeader";
                dynamic hdrRange = hdrBox.TextFrame.TextRange;
                string lineA = "R\u00C9SULTAT DU VOTE \u2014 Diapositive " + votingSlideIndex;
                hdrRange.Text = lineA;
                hdrRange.Font.Name = "Calibri";
                hdrRange.Font.Size = 24;
                hdrRange.Font.Bold = -1;
                hdrRange.Font.Color.RGB = ToOleRgb(15, 98, 182);

                // 1B. Sous-titre (Titre du dossier + Séance/Total/Date) descendu bien à l'intérieur du grand cadre blanc
                dynamic subHdrBox = newSlide.Shapes.AddTextbox(1, 45f, 82f, (float)(slideW - 90), 52f);
                subHdrBox.Name = "VoteEnDirect_ResultSubHeader";
                dynamic subRange = subHdrBox.TextFrame.TextRange;
                string lineC = "S\u00E9ance " + sessionCode + "  \u2022  Total : " + totalVotes + " vote(s) exprim\u00E9(s)  \u2022  " + dateStr;
                subRange.Text = qTitle + "\r\n" + lineC;
                subRange.Font.Name = "Calibri";
                subRange.Paragraphs(1).Font.Size = 16;
                subRange.Paragraphs(1).Font.Bold = -1;
                subRange.Paragraphs(1).Font.Color.RGB = ToOleRgb(15, 23, 42);
                subRange.Paragraphs(2).Font.Size = 12;
                subRange.Paragraphs(2).Font.Bold = 0;
                subRange.Paragraphs(2).Font.Color.RGB = ToOleRgb(100, 116, 139);

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

                dynamic vBanner = newSlide.Shapes.AddShape(5, 45f, 140f, (float)(slideW - 90), 50f);
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

                float startY = 205f;
                float rowGap = 84f;
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

                _pendingGotoSlideAfterInsert = newIdx;
                _pendingFocusRestoreTicks = 3;
                _lastKnownSlideShowPos = newIdx;
                _needsRemoteAssistAfterAction = true;
                if ((int)_pptApp.SlideShowWindows.Count > 0)
                {
                    try
                    {
                        _pptApp.SlideShowWindows.Item(1).View.GotoSlide(newIdx);
                    }
                    catch { }
                    RestoreSlideShowFocus();
                }
                else
                {
                    try { _pptApp.ActiveWindow.View.GotoSlide(newIdx); } catch { }
                }

                Log("Inserted Result Slide at index " + newIdx);
            }
            catch (Exception ex)
            {
                Log("InsertResultSlideBelow err: " + ex.Message);
            }
        }

        private void RefreshSlideHyperlinks(dynamic pres, int slideIndex)
        {
            try
            {
                int total = (int)pres.Slides.Count;
                if (slideIndex < 1 || slideIndex > total) return;
                dynamic slide = pres.Slides.Item(slideIndex);
                int sId = (int)slide.SlideID;
                string expectedSub = sId + "," + slideIndex + ",VoteEnDirect";
                int shCount = (int)slide.Shapes.Count;
                for (int i = 1; i <= shCount; i++)
                {
                    dynamic sh = slide.Shapes.Item(i);
                    string sName = (string)sh.Name ?? "";
                    if (sName.StartsWith("VoteEnDirect_BtnVote") || sName.StartsWith("VoteEnDirect_BtnReset"))
                    {
                        SetShapeSelfHyperlink(sh, expectedSub);
                    }
                }
            }
            catch { }
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
                    // En Mode Normal, si un scrutin est OUVERT sur ce slide (bouton orange CLÔTURER), permettre de cliquer dessus pour clôturer !
                    // Sinon (scrutin fermé), laisser l'utilisateur déplacer et redimensionner librement les boutons.
                    if (_activeVotingSlide == currSlide)
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
                                if (sName.StartsWith("VoteEnDirect_BtnVote"))
                                {
                                    _lastClickUtc = now;
                                    try { _pptApp.ActiveWindow.Selection.Unselect(); } catch { }
                                    Log("Button click (VOTE CLOSE) detected in Normal Mode on slide " + currSlide);
                                    return "VOTE";
                                }
                            }
                        }
                    }
                    return "";
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
                            _lastSlideShowChildHwnd = targetHwnd;
                            IntPtr rootHwnd = GetAncestor(targetHwnd, 2);
                            if (rootHwnd != IntPtr.Zero)
                            {
                                _lastSlideShowHwnd = rootHwnd;
                                if ((rect.Right - rect.Left) < 300 || (rect.Bottom - rect.Top) < 200)
                                {
                                    GetWindowRect(rootHwnd, out rect);
                                }
                            }
                            else
                            {
                                _lastSlideShowHwnd = targetHwnd;
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
                                    double rawMinX = (double)btnVoteShape.Left / slideW;
                                    double rawMaxX = ((double)btnVoteShape.Left + (double)btnVoteShape.Width) / slideW;
                                    double rawMinY = (double)btnVoteShape.Top / slideH;
                                    double rawMaxY = ((double)btnVoteShape.Top + (double)btnVoteShape.Height) / slideH;

                                    // 1. Coordonnées Mode Diaporama Plein Écran
                                    double minX = rawMinX - 0.04;
                                    double maxX = rawMaxX + 0.04;
                                    double minY = rawMinY - 0.04;
                                    double maxY = rawMaxY + 0.04;

                                    // 2. Coordonnées Mode Présentateur (aperçu de la diapositive dans le cadre gauche de l'écran PC)
                                    double pMinX = (0.025 + (rawMinX * 0.435)) - 0.018;
                                    double pMaxX = (0.025 + (rawMaxX * 0.435)) + 0.015;
                                    double pMinY = (0.135 + (rawMinY * 0.680)) - 0.045;
                                    double pMaxY = (0.135 + (rawMaxY * 0.680)) + 0.045;

                                    bool hitFull = (relX >= minX && relX <= maxX && relY >= minY && relY <= maxY);
                                    bool hitPres = (relX >= pMinX && relX <= pMaxX && relY >= pMinY && relY <= pMaxY);
                                    if (hitFull || hitPres)
                                    {
                                        _lastClickUtc = now;
                                        Log("Button click (VOTE) detected in " + (hitPres ? "PresenterView" : "SlideShow") + " Mode on slide " + currSlide);
                                        return "VOTE";
                                    }
                                }

                                if (btnResetShape != null)
                                {
                                    double rawMinX = (double)btnResetShape.Left / slideW;
                                    double rawMaxX = ((double)btnResetShape.Left + (double)btnResetShape.Width) / slideW;
                                    double rawMinY = (double)btnResetShape.Top / slideH;
                                    double rawMaxY = ((double)btnResetShape.Top + (double)btnResetShape.Height) / slideH;

                                    // 1. Coordonnées Mode Diaporama Plein Écran
                                    double minX = rawMinX - 0.02;
                                    double maxX = rawMaxX + 0.02;
                                    double minY = rawMinY - 0.03;
                                    double maxY = rawMaxY + 0.03;

                                    // 2. Coordonnées Mode Présentateur (aperçu de la diapositive dans le cadre gauche de l'écran PC)
                                    double pMinX = (0.025 + (rawMinX * 0.435)) - 0.012;
                                    double pMaxX = (0.025 + (rawMaxX * 0.435)) + 0.020;
                                    double pMinY = (0.135 + (rawMinY * 0.680)) - 0.045;
                                    double pMaxY = (0.135 + (rawMaxY * 0.680)) + 0.045;

                                    bool hitFull = (relX >= minX && relX <= maxX && relY >= minY && relY <= maxY);
                                    bool hitPres = (relX >= pMinX && relX <= pMaxX && relY >= pMinY && relY <= pMaxY);
                                    if (hitFull || hitPres)
                                    {
                                        _lastClickUtc = now;
                                        Log("Button click (RESET) detected in " + (hitPres ? "PresenterView" : "SlideShow") + " Mode on slide " + currSlide);
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

                                // Si l'utilisateur vient de basculer l'affichage entre la projection et le PC (ou de cliquer en Mode Présentateur),
                                // redonner immédiatement le focus clavier à la fenêtre du diaporama et activer le relais de sécurité de la télécommande !
                                _lastKnownSlideShowPos = currSlide;
                                _needsRemoteAssistAfterAction = true;
                                RestoreSlideShowFocus();
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

                _lastKnownSlideShowPos = slideNum;
                _needsRemoteAssistAfterAction = true;
                _pendingFocusRestoreTicks = 2;
                if ((int)_pptApp.SlideShowWindows.Count > 0)
                {
                    try
                    {
                        dynamic ssWin = _pptApp.SlideShowWindows.Item(1);
                        ssWin.View.GotoSlide(slideNum);
                    }
                    catch { }
                    RestoreSlideShowFocus();
                }
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
                if ((int)_pptApp.SlideShowWindows.Count == 0)
                {
                    EnsureVoteElementsOnSlide(pres, pres.Slides.Item(slideNum), true);
                }
                _lastKnownSlideShowPos = slideNum;
                _needsRemoteAssistAfterAction = true;

                string encodedTitle = Uri.EscapeDataString(slideTitle ?? "");
                string resp = CallLocalApi("/api/ppt-action?op=click&slide=" + slideNum + "&title=" + encodedTitle, 2500);
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

                if (_pendingRemoteKeyDir != 0 && (DateTime.UtcNow - _pendingRemoteKeyUtc).TotalMilliseconds >= 100)
                {
                    int dir = _pendingRemoteKeyDir;
                    _pendingRemoteKeyDir = 0;
                    if ((int)_pptApp.SlideShowWindows.Count > 0)
                    {
                        try
                        {
                            dynamic ssView = _pptApp.SlideShowWindows.Item(1).View;
                            int curPos = (int)ssView.CurrentShowPosition;
                            if (_lastKnownSlideShowPos > 0 && curPos == _lastKnownSlideShowPos)
                            {
                                int maxSlides = (int)_pptApp.ActivePresentation.Slides.Count;
                                int targetPos = curPos + dir;
                                if (targetPos >= 1 && targetPos <= maxSlides)
                                {
                                    ssView.GotoSlide(targetPos);
                                    _lastKnownSlideShowPos = targetPos;
                                    Log("Remote assist advanced SlideShow from " + curPos + " to " + targetPos);
                                }
                                RestoreSlideShowFocus();
                            }
                            else
                            {
                                _lastKnownSlideShowPos = curPos;
                            }
                        }
                        catch { }
                    }
                    if (!_hasPendingSlideShowClick && _activeVotingSlide <= 0 && _pendingGotoSlideAfterInsert <= 0 && _pendingFocusRestoreTicks <= 0)
                    {
                        return;
                    }
                }

                if (_hasInitializedPresentation && !_hasPendingSlideShowClick && _activeVotingSlide <= 0 && _pendingGotoSlideAfterInsert <= 0 && _pendingFocusRestoreTicks <= 0)
                {
                    return;
                }

                if (_pendingFocusRestoreTicks > 0 && !_hasPendingSlideShowClick && _pendingGotoSlideAfterInsert <= 0)
                {
                    _pendingFocusRestoreTicks--;
                    RestoreSlideShowFocus();
                    if (_activeVotingSlide <= 0) return;
                }

                if (!_hasInitializedPresentation && (int)_pptApp.ProtectedViewWindows.Count > 0)
                {
                    try { _pptApp.ProtectedViewWindows.Item(1).Edit(); } catch { }
                }
                if ((int)_pptApp.Presentations.Count <= 0)
                {
                    if (!string.IsNullOrEmpty(_lastPresentationKey))
                    {
                        _lastPresentationKey = "";
                        _hasInitializedPresentation = false;
                        CallLocalApi("/api/ppt-action?op=clear_participants&title=Cloture");
                        Log("All presentations closed -> auto-ejected GSM sessions");
                    }
                    return;
                }
                dynamic pres = _pptApp.ActivePresentation;
                if (!_hasInitializedPresentation)
                {
                    EnsurePresentationWritable(ref pres);
                }
                int totalSlides = (int)pres.Slides.Count;
                if (totalSlides < 1) return;

                string currentPresKey = "";
                try { currentPresKey = ((string)pres.FullName ?? (string)pres.Name ?? "").Trim(); } catch { }
                if (!string.IsNullOrEmpty(currentPresKey) && currentPresKey != _lastPresentationKey)
                {
                    _lastPresentationKey = currentPresKey;
                    _hasInitializedPresentation = false;
                    EnsurePresentationWritable(ref pres);
                    string presTitle = "";
                    try { presTitle = Path.GetFileNameWithoutExtension((string)pres.Name ?? "Presentation"); } catch { presTitle = "Presentation"; }
                    CallLocalApi("/api/ppt-action?op=clear_participants&title=" + Uri.EscapeDataString(presTitle));
                    Log("Presentation changed -> auto-cleared participants for: " + currentPresKey);
                }

                if (!_hasInitializedPresentation)
                {
                    _hasInitializedPresentation = true;
                    Log("Initializing presentation (" + totalSlides + " slides)");
                    for (int i = 1; i <= totalSlides; i++)
                    {
                        dynamic s = pres.Slides.Item(i);
                        if (IsVotingSlide(s))
                        {
                            EnsureVoteElementsOnSlide(pres, s, true);
                            SetSlideButtonVisual(pres, i, false, 0);
                        }
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
                    if (inSlideShow)
                    {
                        try
                        {
                            _pptApp.SlideShowWindows.Item(1).View.GotoSlide(targetAfterInsert);
                        }
                        catch { }
                        RestoreSlideShowFocus();
                    }
                    else
                    {
                        try { _pptApp.ActiveWindow.View.GotoSlide(targetAfterInsert); } catch { }
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

                // 2. Synchronisation avec le serveur local uniquement lorsqu'un vote est ouvert sur le slide actif
                if (_activeVotingSlide == currSlide && (DateTime.UtcNow - _lastStatusPollUtc).TotalMilliseconds >= 600)
                {
                    _lastStatusPollUtc = DateTime.UtcNow;
                    string stResp = CallLocalApi("/api/ppt-action?op=status&slide=" + currSlide);
                    if (stResp.StartsWith("OPEN|"))
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
          <button id=""BtnAddVoter""
                  label=""+ Ajouter E-mail (Dernière Minute)""
                  size=""large""
                  imageMso=""ContactPictureMenu""
                  screentip=""Ajouter une adresse e-mail en dernière minute pendant la réunion""
                  supertip=""Ouvre une boîte de saisie pour autoriser immédiatement l'adresse e-mail d'un retardataire sans interrompre la séance.""
                  onAction=""OnClickAddVoter"" />
          <button id=""BtnReloadVoters""
                  label=""Importer Participants (Excel / CSV)""
                  size=""large""
                  imageMso=""FileOpen""
                  screentip=""Injecter un fichier Excel (.xlsx, .xls) ou CSV (.csv) avec la liste des participants""
                  supertip=""Ouvre une fenêtre pour sélectionner un fichier Excel ou CSV contenant les adresses e-mail et noms des participants et l'injecter immédiatement dans la séance.""
                  onAction=""OnClickReloadVoters"" />
          <button id=""BtnListVotants""
                  label=""Rechercher Inscrit / Codes (4 chiffres)""
                  size=""large""
                  imageMso=""FindDialog""
                  screentip=""Rechercher un nom ou une adresse e-mail dans le fichier des inscrits et voir son code à 4 chiffres""
                  supertip=""Ouvre une fenêtre de recherche instantanée regroupant le fichier des adresses e-mail inscrites et leurs codes personnels à 4 chiffres (#XXXX).""
                  onAction=""OnClickListVotants"" />
          <button id=""BtnClearVotants""
                  label=""Réinitialiser la Séance""
                  size=""large""
                  imageMso=""Delete""
                  screentip=""Réinitialiser les connexions GSM et les codes à 4 chiffres pour une nouvelle séance""
                  supertip=""Déconnecte les GSM et remet la liste officielle des e-mails en attente de 1re connexion.""
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
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:5173");
                req.Timeout = 250;
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
                        string nodeExe = @"C:\Program Files\nodejs\node.exe";
                        if (!File.Exists(nodeExe)) nodeExe = "node";
                        ProcessStartInfo psi = new ProcessStartInfo(nodeExe, "\"" + viteScript + "\"")
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
                string url = "http://127.0.0.1:5173/?" + queryParams + "&pptSlide=" + slideNum + "&pptTitle=" + encodedTitle + "&t=" + DateTime.Now.Ticks;
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

        public void OnClickAddVoter(object control)
        {
            try
            {
                EnsureViteServerRunning();
                Form prompt = new Form()
                {
                    Width = 460,
                    Height = 210,
                    FormBorderStyle = FormBorderStyle.FixedDialog,
                    Text = "Vote en Direct — Ajouter un E-mail en Dernière Minute",
                    StartPosition = FormStartPosition.CenterScreen,
                    MaximizeBox = false,
                    MinimizeBox = false,
                    TopMost = true
                };
                Label lbl = new Label()
                {
                    Left = 18,
                    Top = 18,
                    Width = 410,
                    Height = 40,
                    Text = "Entrez l'adresse e-mail à autoriser (ex: marc.martin@gmail.com ou marc.martin@gmail.com ; Marc Martin) :"
                };
                TextBox txtBox = new TextBox()
                {
                    Left = 18,
                    Top = 64,
                    Width = 405
                };
                Button btnOk = new Button()
                {
                    Text = "Ajouter immédiatement",
                    Left = 175,
                    Width = 150,
                    Top = 110,
                    Height = 32,
                    DialogResult = DialogResult.OK
                };
                Button btnCancel = new Button()
                {
                    Text = "Annuler",
                    Left = 333,
                    Width = 90,
                    Top = 110,
                    Height = 32,
                    DialogResult = DialogResult.Cancel
                };
                prompt.Controls.Add(lbl);
                prompt.Controls.Add(txtBox);
                prompt.Controls.Add(btnOk);
                prompt.Controls.Add(btnCancel);
                prompt.AcceptButton = btnOk;
                prompt.CancelButton = btnCancel;

                if (prompt.ShowDialog() == DialogResult.OK)
                {
                    string inputVal = (txtBox.Text ?? "").Trim();
                    if (!string.IsNullOrEmpty(inputVal))
                    {
                        string resp = CallLocalApi("/api/ppt-action?op=add_voter&email=" + Uri.EscapeDataString(inputVal));
                        Log("OnClickAddVoter -> " + resp);
                        if (resp.StartsWith("ADDED|"))
                        {
                            MessageBox.Show("Le votant a été ajouté à la liste officielle et sur Supabase :\r\n\r\n" + resp.Substring(6) + "\r\n\r\nIl peut maintenant se connecter immédiatement sur son GSM avec son adresse e-mail.", "Vote en Direct — Votant Ajouté", MessageBoxButtons.OK, MessageBoxIcon.Information);
                        }
                        else
                        {
                            MessageBox.Show("Impossible d'ajouter cette adresse e-mail. Vérifiez qu'elle contient bien un '@'.", "Vote en Direct", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("Erreur : " + ex.Message, "Vote en Direct");
            }
        }

        private bool TryParseParticipantCells(string[] cells, out string email, out string name)
        {
            email = "";
            name = "";
            if (cells == null || cells.Length == 0) return false;

            Regex emailRx = new Regex(@"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}");
            int emailCellIdx = -1;
            for (int i = 0; i < cells.Length; i++)
            {
                string c = (cells[i] ?? "").Trim();
                Match m = emailRx.Match(c);
                if (m.Success)
                {
                    email = m.Value.ToLowerInvariant().Trim();
                    emailCellIdx = i;
                    break;
                }
            }
            if (string.IsNullOrEmpty(email)) return false;

            List<string> nameParts = new List<string>();
            for (int i = 0; i < cells.Length; i++)
            {
                if (i == emailCellIdx) continue;
                string c = (cells[i] ?? "").Trim().Trim('"', '\'');
                if (string.IsNullOrEmpty(c)) continue;
                if (c.Contains("@")) continue;
                double dummyNum;
                if (double.TryParse(c, out dummyNum)) continue;
                nameParts.Add(c);
                if (nameParts.Count >= 2) break;
            }

            if (nameParts.Count > 0)
            {
                name = string.Join(" ", nameParts.ToArray()).Trim();
            }
            else
            {
                string prefix = email.Split('@')[0].Replace('.', ' ').Replace('_', ' ').Replace('-', ' ').Trim();
                if (prefix.Length > 0)
                {
                    string[] words = prefix.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                    for (int w = 0; w < words.Length; w++)
                    {
                        if (words[w].Length > 1)
                            words[w] = char.ToUpperInvariant(words[w][0]) + words[w].Substring(1).ToLowerInvariant();
                        else
                            words[w] = words[w].ToUpperInvariant();
                    }
                    name = string.Join(" ", words);
                }
                else
                {
                    name = email;
                }
            }
            return true;
        }

        private List<KeyValuePair<string, string>> ExtractParticipantsFromFile(string filePath)
        {
            List<KeyValuePair<string, string>> result = new List<KeyValuePair<string, string>>();
            HashSet<string> seenEmails = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            string ext = (Path.GetExtension(filePath) ?? "").ToLowerInvariant();

            string tempCopy = Path.Combine(Path.GetTempPath(), "vote_import_" + Guid.NewGuid().ToString("N") + ext);
            try
            {
                File.Copy(filePath, tempCopy, true);

                if (ext == ".xlsx")
                {
                    using (ZipArchive zip = ZipFile.OpenRead(tempCopy))
                    {
                        List<string> sharedStrings = new List<string>();
                        ZipArchiveEntry ssEntry = zip.GetEntry("xl/sharedStrings.xml");
                        if (ssEntry != null)
                        {
                            XmlDocument ssDoc = new XmlDocument();
                            using (Stream s = ssEntry.Open())
                            {
                                ssDoc.Load(s);
                            }
                            XmlNodeList siNodes = ssDoc.SelectNodes("//*[local-name()='si']");
                            if (siNodes != null)
                            {
                                foreach (XmlNode si in siNodes)
                                {
                                    sharedStrings.Add(si.InnerText ?? "");
                                }
                            }
                        }

                        foreach (ZipArchiveEntry entry in zip.Entries)
                        {
                            if (!entry.FullName.StartsWith("xl/worksheets/sheet", StringComparison.OrdinalIgnoreCase) ||
                                !entry.FullName.EndsWith(".xml", StringComparison.OrdinalIgnoreCase))
                            {
                                continue;
                            }

                            XmlDocument sheetDoc = new XmlDocument();
                            using (Stream s = entry.Open())
                            {
                                sheetDoc.Load(s);
                            }
                            XmlNodeList rowNodes = sheetDoc.SelectNodes("//*[local-name()='row']");
                            if (rowNodes == null) continue;

                            foreach (XmlNode rowNode in rowNodes)
                            {
                                XmlNodeList cNodes = rowNode.SelectNodes("./*[local-name()='c']");
                                if (cNodes == null || cNodes.Count == 0) continue;
                                List<string> rowCells = new List<string>();
                                foreach (XmlNode cNode in cNodes)
                                {
                                    string cType = "";
                                    if (cNode.Attributes != null && cNode.Attributes["t"] != null)
                                    {
                                        cType = cNode.Attributes["t"].Value ?? "";
                                    }
                                    string val = "";
                                    if (cType == "s")
                                    {
                                        XmlNode vNode = cNode.SelectSingleNode("./*[local-name()='v']");
                                        int ssIdx;
                                        if (vNode != null && int.TryParse((vNode.InnerText ?? "").Trim(), out ssIdx) && ssIdx >= 0 && ssIdx < sharedStrings.Count)
                                        {
                                            val = sharedStrings[ssIdx];
                                        }
                                    }
                                    else if (cType == "inlineStr")
                                    {
                                        XmlNode isNode = cNode.SelectSingleNode(".//*[local-name()='t']");
                                        if (isNode != null) val = isNode.InnerText ?? "";
                                    }
                                    else
                                    {
                                        XmlNode vNode = cNode.SelectSingleNode("./*[local-name()='v']");
                                        if (vNode != null) val = vNode.InnerText ?? "";
                                    }
                                    if (!string.IsNullOrEmpty(val))
                                    {
                                        rowCells.Add(val.Trim());
                                    }
                                }
                                string em, nm;
                                if (TryParseParticipantCells(rowCells.ToArray(), out em, out nm) && !seenEmails.Contains(em))
                                {
                                    seenEmails.Add(em);
                                    result.Add(new KeyValuePair<string, string>(em, nm));
                                }
                            }
                        }
                    }
                }
                else if (ext == ".xls")
                {
                    dynamic excelApp = null;
                    dynamic wb = null;
                    try
                    {
                        Type excelType = Type.GetTypeFromProgID("Excel.Application");
                        if (excelType != null)
                        {
                            excelApp = Activator.CreateInstance(excelType);
                            excelApp.Visible = false;
                            excelApp.DisplayAlerts = false;
                            wb = excelApp.Workbooks.Open(tempCopy, 0, true);
                            dynamic ws = wb.Worksheets.Item(1);
                            dynamic usedRange = ws.UsedRange;
                            int rowCount = (int)usedRange.Rows.Count;
                            int colCount = Math.Min(15, (int)usedRange.Columns.Count);
                            for (int r = 1; r <= rowCount; r++)
                            {
                                List<string> rowCells = new List<string>();
                                for (int c = 1; c <= colCount; c++)
                                {
                                    try
                                    {
                                        object cellVal = usedRange.Cells[r, c].Text;
                                        string sVal = (cellVal != null ? cellVal.ToString() : "").Trim();
                                        if (!string.IsNullOrEmpty(sVal)) rowCells.Add(sVal);
                                    }
                                    catch { }
                                }
                                string em, nm;
                                if (TryParseParticipantCells(rowCells.ToArray(), out em, out nm) && !seenEmails.Contains(em))
                                {
                                    seenEmails.Add(em);
                                    result.Add(new KeyValuePair<string, string>(em, nm));
                                }
                            }
                        }
                    }
                    finally
                    {
                        try { if (wb != null) wb.Close(false); } catch { }
                        try { if (excelApp != null) excelApp.Quit(); } catch { }
                    }
                }
                else
                {
                    byte[] rawBytes = File.ReadAllBytes(tempCopy);
                    string content;
                    try
                    {
                        UTF8Encoding utf8Strict = new UTF8Encoding(false, true);
                        content = utf8Strict.GetString(rawBytes);
                    }
                    catch
                    {
                        content = Encoding.Default.GetString(rawBytes);
                    }

                    string[] lines = content.Split(new char[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                    foreach (string rawLine in lines)
                    {
                        string trimmed = rawLine.Trim();
                        if (string.IsNullOrEmpty(trimmed) || trimmed.StartsWith("#")) continue;
                        string[] cells = trimmed.Split(new char[] { ';', ',', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                        string em, nm;
                        if (TryParseParticipantCells(cells, out em, out nm) && !seenEmails.Contains(em))
                        {
                            seenEmails.Add(em);
                            result.Add(new KeyValuePair<string, string>(em, nm));
                        }
                    }
                }
            }
            finally
            {
                try { if (File.Exists(tempCopy)) File.Delete(tempCopy); } catch { }
            }

            return result;
        }

        public void OnClickReloadVoters(object control)
        {
            try
            {
                EnsureViteServerRunning();
                OpenFileDialog ofd = new OpenFileDialog();
                ofd.Title = "Vote en Direct — Sélectionner le fichier Excel ou CSV des participants";
                ofd.Filter = "Fichiers Excel ou CSV (*.xlsx;*.xls;*.csv;*.txt)|*.xlsx;*.xls;*.csv;*.txt|Fichiers Excel (*.xlsx;*.xls)|*.xlsx;*.xls|Fichiers CSV (*.csv;*.txt)|*.csv;*.txt|Tous les fichiers (*.*)|*.*";

                try
                {
                    if (_pptApp != null && (int)_pptApp.Presentations.Count > 0)
                    {
                        string presPath = (string)_pptApp.ActivePresentation.FullName ?? "";
                        if (!string.IsNullOrEmpty(presPath) && File.Exists(presPath))
                        {
                            ofd.InitialDirectory = Path.GetDirectoryName(presPath);
                        }
                    }
                }
                catch { }

                if (ofd.ShowDialog() != DialogResult.OK || string.IsNullOrEmpty(ofd.FileName))
                {
                    return;
                }

                List<KeyValuePair<string, string>> imported = ExtractParticipantsFromFile(ofd.FileName);
                if (imported.Count == 0)
                {
                    MessageBox.Show(
                        "Aucune adresse e-mail valide (contenant '@') n'a été trouvée dans le fichier sélectionné :\r\n" + Path.GetFileName(ofd.FileName) + "\r\n\r\nVérifiez que votre fichier Excel ou CSV contient bien une colonne avec les adresses e-mail des participants.",
                        "Vote en Direct — Aucune adresse e-mail détectée",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Warning
                    );
                    return;
                }

                DialogResult modeDr = MessageBox.Show(
                    imported.Count + " participant(s) avec adresse e-mail ont été détectés dans « " + Path.GetFileName(ofd.FileName) + " ».\r\n\r\n" +
                    "• Cliquez sur OUI pour REMPLACER la liste actuelle par cette nouvelle liste.\r\n" +
                    "• Cliquez sur NON pour AJOUTER ces participants à la liste existante.",
                    "Vote en Direct — Mode d'importation des participants",
                    MessageBoxButtons.YesNoCancel,
                    MessageBoxIcon.Question
                );
                if (modeDr == DialogResult.Cancel) return;

                bool replaceMode = (modeDr == DialogResult.Yes);
                string csvPath = Path.Combine(_projectRoot, "liste-votants.csv");

                List<string> outLines = new List<string>();
                outLines.Add("# Liste officielle des votants autorisés (Format: email;Nom Prénom)");
                HashSet<string> finalEmails = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

                if (!replaceMode && File.Exists(csvPath))
                {
                    List<KeyValuePair<string, string>> existing = ExtractParticipantsFromFile(csvPath);
                    foreach (KeyValuePair<string, string> kv in existing)
                    {
                        if (!finalEmails.Contains(kv.Key))
                        {
                            finalEmails.Add(kv.Key);
                            outLines.Add(kv.Key + ";" + kv.Value);
                        }
                    }
                }

                foreach (KeyValuePair<string, string> kv in imported)
                {
                    if (!finalEmails.Contains(kv.Key))
                    {
                        finalEmails.Add(kv.Key);
                        outLines.Add(kv.Key + ";" + kv.Value);
                    }
                }

                File.WriteAllLines(csvPath, outLines.ToArray(), Encoding.UTF8);
                string resp = CallLocalApi("/api/ppt-action?op=reload_voters&prune=" + (replaceMode ? "1" : "0") + "&reset=" + (replaceMode ? "1" : "0"), 12000);
                Log("OnClickReloadVoters (file=" + ofd.FileName + ", replace=" + replaceMode + ") -> " + resp);

                StringBuilder preview = new StringBuilder();
                int previewCount = Math.Min(8, imported.Count);
                for (int i = 0; i < previewCount; i++)
                {
                    preview.AppendLine("  • " + imported[i].Value + " <" + imported[i].Key + ">");
                }
                if (imported.Count > previewCount)
                {
                    preview.AppendLine("  ... et " + (imported.Count - previewCount) + " autre(s) participant(s).");
                }

                MessageBox.Show(
                    "Importation réussie dans la séance et sur Supabase !\r\n\r\n" +
                    "Fichier injecté : " + Path.GetFileName(ofd.FileName) + "\r\n" +
                    "Participants autorisés dans la séance : " + finalEmails.Count + "\r\n\r\n" +
                    "Aperçu des participants importés :\r\n" + preview.ToString(),
                    "Vote en Direct — Liste des Participants Injectée",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
            }
            catch (Exception ex)
            {
                MessageBox.Show("Erreur lors de l'importation du fichier : " + ex.Message, "Vote en Direct");
            }
        }

        private class VoterDirectoryEntry
        {
            public int Index;
            public string Name;
            public string Email;
            public string StatusText;
            public bool IsConnected;
        }

        private List<VoterDirectoryEntry> LoadVoterDirectoryEntries()
        {
            List<VoterDirectoryEntry> entries = new List<VoterDirectoryEntry>();
            Dictionary<string, VoterDirectoryEntry> byEmail = new Dictionary<string, VoterDirectoryEntry>(StringComparer.OrdinalIgnoreCase);

            // 1. Read local email file (liste-votants.csv) first so 100% of registered emails are always present
            string csvPath = Path.Combine(_projectRoot, "liste-votants.csv");
            if (File.Exists(csvPath))
            {
                try
                {
                    List<KeyValuePair<string, string>> localVoters = ExtractParticipantsFromFile(csvPath);
                    for (int i = 0; i < localVoters.Count; i++)
                    {
                        string email = (localVoters[i].Key ?? "").Trim().ToLowerInvariant();
                        string name = (localVoters[i].Value ?? "").Trim();
                        if (string.IsNullOrEmpty(email)) continue;
                        if (byEmail.ContainsKey(email)) continue;
                        VoterDirectoryEntry entry = new VoterDirectoryEntry()
                        {
                            Index = entries.Count + 1,
                            Name = name,
                            Email = email,
                            StatusText = "Inscrit (En attente de 1re connexion)",
                            IsConnected = false
                        };
                        entries.Add(entry);
                        byEmail[email] = entry;
                    }
                }
                catch { }
            }

            // 2. Overlay live status & 4-digit codes from local API / Supabase
            try
            {
                string resp = CallLocalApi("/api/ppt-action?op=list_participants", 4500);
                Log("OnClickListVotants -> " + (resp != null ? resp.Length + " chars" : "null"));
                if (!string.IsNullOrEmpty(resp) && resp != "EMPTY")
                {
                    string[] lines = resp.Split(new char[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                    for (int i = 0; i < lines.Length; i++)
                    {
                        string line = lines[i].Trim();
                        if (string.IsNullOrEmpty(line)) continue;

                        // Strip leading "12. "
                        int dotIdx = line.IndexOf(". ");
                        if (dotIdx > 0 && dotIdx <= 6)
                        {
                            line = line.Substring(dotIdx + 2).Trim();
                        }

                        string statusPart = "Inscrit (En attente de 1re connexion)";
                        bool connected = false;
                        string labelPart = line;
                        int sepIdx = line.IndexOf("—");
                        if (sepIdx > 0)
                        {
                            labelPart = line.Substring(0, sepIdx).Trim();
                            string rawStatus = line.Substring(sepIdx + 1).Trim();
                            if (rawStatus.IndexOf("CONNECTÉ", StringComparison.OrdinalIgnoreCase) >= 0)
                            {
                                connected = true;
                                statusPart = rawStatus;
                            }
                            else
                            {
                                statusPart = "Inscrit (En attente de 1re connexion)";
                            }
                        }

                        string email = "";
                        string name = labelPart;
                        int lt = labelPart.IndexOf('<');
                        int gt = labelPart.IndexOf('>');
                        if (lt >= 0 && gt > lt)
                        {
                            name = labelPart.Substring(0, lt).Trim();
                            email = labelPart.Substring(lt + 1, gt - lt - 1).Trim().ToLowerInvariant();
                        }
                        else if (labelPart.Contains("@"))
                        {
                            email = labelPart.Trim().ToLowerInvariant();
                            name = email.Split('@')[0];
                        }

                        if (!string.IsNullOrEmpty(email) && byEmail.ContainsKey(email))
                        {
                            VoterDirectoryEntry existing = byEmail[email];
                            if (!string.IsNullOrEmpty(name)) existing.Name = name;
                            existing.StatusText = statusPart;
                            existing.IsConnected = connected;
                        }
                        else
                        {
                            VoterDirectoryEntry extra = new VoterDirectoryEntry()
                            {
                                Index = entries.Count + 1,
                                Name = string.IsNullOrEmpty(name) ? labelPart : name,
                                Email = email,
                                StatusText = statusPart,
                                IsConnected = connected
                            };
                            entries.Add(extra);
                            if (!string.IsNullOrEmpty(email)) byEmail[email] = extra;
                        }
                    }
                }
            }
            catch { }

            return entries;
        }

        public void OnClickListVotants(object control)
        {
            try
            {
                EnsureViteServerRunning();
                List<VoterDirectoryEntry> allEntries = LoadVoterDirectoryEntries();

                Form dlg = new Form()
                {
                    Width = 840,
                    Height = 600,
                    MinimumSize = new Size(720, 460),
                    Text = "Vote en Direct — Recherche dans le Fichier des Adresses E-mail & Codes à 4 Chiffres",
                    StartPosition = FormStartPosition.CenterScreen,
                    TopMost = true,
                    Font = new Font("Segoe UI", 9.5F, FontStyle.Regular)
                };

                Label lblSearch = new Label()
                {
                    Left = 16,
                    Top = 14,
                    Width = 540,
                    Height = 22,
                    Text = "Rechercher un nom, un prénom, une adresse e-mail ou un code (#XXXX) :",
                    Font = new Font("Segoe UI", 9.5F, FontStyle.Bold)
                };

                TextBox txtSearch = new TextBox()
                {
                    Left = 16,
                    Top = 38,
                    Width = 430,
                    Height = 28,
                    Font = new Font("Segoe UI", 11F, FontStyle.Regular),
                    Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
                };

                Button btnClearSearch = new Button()
                {
                    Left = 452,
                    Top = 37,
                    Width = 75,
                    Height = 29,
                    Text = "Effacer",
                    Anchor = AnchorStyles.Top | AnchorStyles.Right
                };

                CheckBox chkConnectedOnly = new CheckBox()
                {
                    Left = 540,
                    Top = 40,
                    Width = 175,
                    Height = 24,
                    Text = "Connectés uniquement",
                    Anchor = AnchorStyles.Top | AnchorStyles.Right
                };

                Label lblCount = new Label()
                {
                    Left = 16,
                    Top = 72,
                    Width = 790,
                    Height = 22,
                    ForeColor = Color.FromArgb(30, 64, 175),
                    Font = new Font("Segoe UI", 9.5F, FontStyle.Bold),
                    Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
                };

                ListView lv = new ListView()
                {
                    Left = 16,
                    Top = 98,
                    Width = 792,
                    Height = 400,
                    View = View.Details,
                    FullRowSelect = true,
                    GridLines = true,
                    HideSelection = false,
                    Font = new Font("Segoe UI", 10F, FontStyle.Regular),
                    Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right
                };
                lv.Columns.Add("N°", 52, HorizontalAlignment.Left);
                lv.Columns.Add("Nom / Identifiant", 215, HorizontalAlignment.Left);
                lv.Columns.Add("Adresse E-mail (Fichier inscrits)", 275, HorizontalAlignment.Left);
                lv.Columns.Add("Statut & Code à 4 chiffres", 225, HorizontalAlignment.Left);

                Action refreshList = () =>
                {
                    string q = (txtSearch.Text ?? "").Trim().ToLowerInvariant();
                    bool onlyConn = chkConnectedOnly.Checked;
                    int connectedTotal = 0;
                    for (int i = 0; i < allEntries.Count; i++)
                    {
                        if (allEntries[i].IsConnected) connectedTotal++;
                    }

                    lv.BeginUpdate();
                    lv.Items.Clear();
                    int shown = 0;
                    for (int i = 0; i < allEntries.Count; i++)
                    {
                        VoterDirectoryEntry e = allEntries[i];
                        if (onlyConn && !e.IsConnected) continue;
                        if (!string.IsNullOrEmpty(q))
                        {
                            bool matchName = (e.Name ?? "").ToLowerInvariant().Contains(q);
                            bool matchEmail = (e.Email ?? "").ToLowerInvariant().Contains(q);
                            bool matchStatus = (e.StatusText ?? "").ToLowerInvariant().Contains(q);
                            if (!matchName && !matchEmail && !matchStatus) continue;
                        }

                        ListViewItem item = new ListViewItem(e.Index.ToString());
                        item.SubItems.Add(e.Name ?? "");
                        item.SubItems.Add(e.Email ?? "");
                        item.SubItems.Add(e.StatusText ?? "");
                        if (e.IsConnected)
                        {
                            item.ForeColor = Color.FromArgb(21, 128, 61);
                        }
                        else
                        {
                            item.ForeColor = Color.FromArgb(51, 65, 85);
                        }
                        lv.Items.Add(item);
                        shown++;
                    }
                    lv.EndUpdate();

                    if (string.IsNullOrEmpty(q) && !onlyConn)
                    {
                        lblCount.Text = string.Format("Fichier des inscrits : {0} adresse(s) e-mail enregistrée(s) — {1} connecté(s) avec code à 4 chiffres", allEntries.Count, connectedTotal);
                    }
                    else
                    {
                        lblCount.Text = string.Format("Résultat de la recherche : {0} trouvé(s) sur {1} inscrit(s) ({2} connecté(s) au total)", shown, allEntries.Count, connectedTotal);
                    }
                };

                txtSearch.TextChanged += (s, e) => refreshList();
                chkConnectedOnly.CheckedChanged += (s, e) => refreshList();
                btnClearSearch.Click += (s, e) =>
                {
                    txtSearch.Text = "";
                    txtSearch.Focus();
                };

                Button btnAddMissing = new Button()
                {
                    Left = 16,
                    Top = 512,
                    Width = 240,
                    Height = 34,
                    Text = "+ Ajouter un e-mail manquant",
                    Anchor = AnchorStyles.Bottom | AnchorStyles.Left
                };
                btnAddMissing.Click += (s, e) =>
                {
                    OnClickAddVoter(null);
                    allEntries = LoadVoterDirectoryEntries();
                    refreshList();
                };

                Button btnRefresh = new Button()
                {
                    Left = 266,
                    Top = 512,
                    Width = 200,
                    Height = 34,
                    Text = "Actualiser la liste & les codes",
                    Anchor = AnchorStyles.Bottom | AnchorStyles.Left
                };
                btnRefresh.Click += (s, e) =>
                {
                    allEntries = LoadVoterDirectoryEntries();
                    refreshList();
                };

                Button btnClose = new Button()
                {
                    Left = 688,
                    Top = 512,
                    Width = 120,
                    Height = 34,
                    Text = "Fermer",
                    DialogResult = DialogResult.Cancel,
                    Anchor = AnchorStyles.Bottom | AnchorStyles.Right
                };

                dlg.Controls.Add(lblSearch);
                dlg.Controls.Add(txtSearch);
                dlg.Controls.Add(btnClearSearch);
                dlg.Controls.Add(chkConnectedOnly);
                dlg.Controls.Add(lblCount);
                dlg.Controls.Add(lv);
                dlg.Controls.Add(btnAddMissing);
                dlg.Controls.Add(btnRefresh);
                dlg.Controls.Add(btnClose);
                dlg.CancelButton = btnClose;

                refreshList();
                dlg.Shown += (s, e) => txtSearch.Focus();
                dlg.ShowDialog();
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
