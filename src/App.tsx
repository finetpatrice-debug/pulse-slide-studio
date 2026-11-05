import { Routes, Route, Navigate } from 'react-router-dom';
import { PresentationProvider } from './context/PresentationContext';
import TrainerDashboardPage from './pages/TrainerDashboardPage';
import PresenterSlideshowPage from './pages/PresenterSlideshowPage';
import ParticipantJoinPage from './pages/ParticipantJoinPage';

export default function App() {
  return (
    <PresentationProvider>
      <Routes>
        <Route path="/" element={<TrainerDashboardPage />} />
        <Route path="/present/:sessionCode" element={<PresenterSlideshowPage />} />
        <Route path="/join/:sessionCode" element={<ParticipantJoinPage />} />
        <Route path="/join" element={<ParticipantJoinPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </PresentationProvider>
  );
}
