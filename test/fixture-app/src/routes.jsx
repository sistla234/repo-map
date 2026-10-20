// Router definition (not executed by the fixture; used to test route detection)
import { Routes, Route, Navigate } from 'react-router-dom';
export const AppRoutes = () => (
  <Routes>
    <Route path="/" element={<Home />} />
    <Route path="/old" element={<Navigate to="/" replace />} />
    <Route path="/insights">
      <Route index element={<Navigate to="/insights/dashboards" />} />
      <Route path="dashboards" element={<Dashboards />} />
    </Route>
    <Route path="/settings" element={<Gate><Settings /></Gate>} />
    <Route path="/item/:id" element={<Item />} />
    <Route path="*" element={<NotFound />} />
  </Routes>
);
