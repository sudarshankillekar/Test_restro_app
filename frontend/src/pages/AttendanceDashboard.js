import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import {
  CalendarDays,
  Camera,
  CheckCircle2,
  Coffee,
  Download,
  LogIn,
  LogOut,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
  ShieldCheck,
  UserCheck,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';

const MANAGER_ROLES = ['admin', 'billing', 'kitchen_billing'];
const ACTIONS = [
  { value: 'clock_in', label: 'Clock In', icon: LogIn, className: 'bg-emerald-600 hover:bg-emerald-700' },
  { value: 'clock_out', label: 'Clock Out', icon: LogOut, className: 'bg-slate-900 hover:bg-slate-800' },
  { value: 'break_in', label: 'Break Start', icon: Coffee, className: 'bg-amber-600 hover:bg-amber-700' },
  { value: 'break_out', label: 'Break End', icon: Coffee, className: 'bg-sky-600 hover:bg-sky-700' },
];
const FACE_LANDMARKER_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task';
const FACE_LANDMARKER_WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';
const FACE_GUIDE = { cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.43 };
const REGISTRATION_STAGES = [
  { key: 'front', instruction: 'Look straight', start: 0, end: 15, samples: 3 },
  { key: 'left', instruction: 'Turn slightly left', start: 15, end: 30, samples: 2 },
  { key: 'right', instruction: 'Turn slightly right', start: 30, end: 45, samples: 2 },
  { key: 'up', instruction: 'Look slightly upward', start: 45, end: 60, samples: 2 },
  { key: 'down', instruction: 'Look slightly downward', start: 60, end: 75, samples: 2 },
  { key: 'blink', instruction: 'Blink once', start: 75, end: 85, samples: 1 },
  { key: 'closer', instruction: 'Move slightly closer', start: 85, end: 95, samples: 2 },
  { key: 'final', instruction: 'Final front-facing scan', start: 95, end: 100, samples: 2 },
];
const SELECTED_LANDMARKS = [
  1, 4, 10, 33, 46, 52, 55, 61, 63, 66, 70, 105, 107, 133, 145, 152,
  159, 172, 234, 263, 276, 282, 285, 291, 293, 296, 300, 334, 336, 362,
  374, 386, 397, 454, 468, 473,
];
const createStageSamples = () => REGISTRATION_STAGES.map(() => []);
const calculateRegistrationProgress = (stageSamples) => {
  let progress = 0;
  for (let index = 0; index < REGISTRATION_STAGES.length; index += 1) {
    const stage = REGISTRATION_STAGES[index];
    const count = stageSamples[index]?.length || 0;
    const ratio = clamp(count / stage.samples, 0, 1);
    progress = stage.start + (stage.end - stage.start) * ratio;
    if (ratio < 1) return Math.round(progress);
  }
  return 100;
};
const findCurrentStageIndex = (stageSamples) => {
  const index = REGISTRATION_STAGES.findIndex((stage, stageIndex) => (stageSamples[stageIndex]?.length || 0) < stage.samples);
  return index === -1 ? REGISTRATION_STAGES.length - 1 : index;
};

const emptySettings = {
  shift_start: '10:00',
  shift_end: '22:00',
  grace_minutes: 10,
  overtime_after_hours: 9,
  confidence_threshold: 0.68,
  snapshot_audit_enabled: false,
  pin_fallback_enabled: true,
};

const getIndiaDate = () => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const parseBackendDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const hasExplicitTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
    const isoWithoutTimezone = /^\d{4}-\d{2}-\d{2}T/.test(trimmed) && !hasExplicitTimezone;
    const date = new Date(isoWithoutTimezone ? `${trimmed}Z` : trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatDateTime = (value) => {
  const date = parseBackendDate(value);
  if (!date) return '-';

  return `${new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'Asia/Kolkata',
  }).format(date)} IST`;
};

const formatMinutes = (minutes = 0) => {
  const safeMinutes = Number(minutes || 0);
  const hours = Math.floor(safeMinutes / 60);
  const remainder = safeMinutes % 60;
  if (!hours) return `${remainder}m`;
  return `${hours}h ${remainder}m`;
};

const roleLabel = (role = '') => role.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());

const hasSelectValue = (value) => typeof value === 'string' && value.trim().length > 0;

const getPunchSuccessMessage = (eventName = '') => {
  const messages = {
    attendance_clock_in: 'Checked in successfully',
    attendance_clock_out: 'Checked out successfully',
    attendance_break_in: 'Break started successfully',
    attendance_break_out: 'Break ended successfully',
  };
  return messages[eventName] || 'Attendance marked successfully';
};

const getPunchTimestamp = (punch) => {
  if (!punch?.log) return new Date().toISOString();
  const timestamps = {
    attendance_clock_in: punch.log.clock_in,
    attendance_clock_out: punch.log.clock_out,
    attendance_break_in: punch.log.updated_at,
    attendance_break_out: punch.log.updated_at,
  };
  return timestamps[punch.event] || punch.log.updated_at || new Date().toISOString();
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const distance = (a, b) => Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));

const getBlendScore = (blendshapes, categoryName) => {
  const category = blendshapes?.categories?.find((item) => item.categoryName === categoryName);
  return category?.score || 0;
};

const cosineSimilarity = (left = [], right = []) => {
  const length = Math.min(left.length, right.length);
  if (!length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
};

const getLandmarkBox = (landmarks = []) => {
  const xs = landmarks.map((point) => point.x);
  const ys = landmarks.map((point) => point.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
};

const getPose = (landmarks = []) => {
  const leftEye = landmarks[33];
  const rightEye = landmarks[263];
  const nose = landmarks[1] || landmarks[4];
  const chin = landmarks[152];
  const forehead = landmarks[10];
  const mouthLeft = landmarks[61];
  const mouthRight = landmarks[291];
  const eyeMid = {
    x: (leftEye.x + rightEye.x) / 2,
    y: (leftEye.y + rightEye.y) / 2,
  };
  const mouthMid = {
    x: (mouthLeft.x + mouthRight.x) / 2,
    y: (mouthLeft.y + mouthRight.y) / 2,
  };
  const eyeDistance = Math.max(distance(leftEye, rightEye), 0.001);
  const faceHeight = Math.max((chin?.y || 0) - (forehead?.y || 0), 0.001);
  const roll = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x) * (180 / Math.PI);
  const yaw = (nose.x - eyeMid.x) / eyeDistance;
  const noseToEye = nose.y - eyeMid.y;
  const eyeToMouth = Math.max(mouthMid.y - eyeMid.y, 0.001);
  const pitch = (noseToEye / eyeToMouth) - 0.43;
  return {
    yaw,
    pitch,
    roll,
    faceHeight,
  };
};

const isBoxInsideOval = (box) => {
  const points = [
    [box.minX, box.minY],
    [box.maxX, box.minY],
    [box.minX, box.maxY],
    [box.maxX, box.maxY],
    [(box.minX + box.maxX) / 2, box.minY],
    [(box.minX + box.maxX) / 2, box.maxY],
  ];
  return points.every(([x, y]) => (((x - FACE_GUIDE.cx) ** 2) / (FACE_GUIDE.rx ** 2)) + (((y - FACE_GUIDE.cy) ** 2) / (FACE_GUIDE.ry ** 2)) <= 1.08);
};

const getImageQuality = (video, canvas, crop) => {
  const width = 96;
  const height = 96;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
  const image = context.getImageData(0, 0, width, height).data;
  let brightnessTotal = 0;
  let edgeTotal = 0;
  let samples = 0;
  const gray = new Array(width * height);

  for (let index = 0; index < image.length; index += 4) {
    const value = image[index] * 0.299 + image[index + 1] * 0.587 + image[index + 2] * 0.114;
    gray[index / 4] = value;
    brightnessTotal += value;
  }

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const center = gray[y * width + x] * 4;
      const laplacian = Math.abs(center - gray[y * width + x - 1] - gray[y * width + x + 1] - gray[(y - 1) * width + x] - gray[(y + 1) * width + x]);
      edgeTotal += laplacian;
      samples += 1;
    }
  }

  const brightness = brightnessTotal / (width * height);
  const blurScore = edgeTotal / Math.max(samples, 1);
  return {
    brightness,
    blurScore,
    lightingOk: brightness >= 58 && brightness <= 205,
    blurOk: blurScore >= 10,
  };
};

const getCropFromLandmarks = (video, landmarks = []) => {
  if (!landmarks.length) return null;
  const box = getLandmarkBox(landmarks);
  const frameWidth = video.videoWidth;
  const frameHeight = video.videoHeight;
  const paddingX = (box.maxX - box.minX) * frameWidth * 0.22;
  const paddingY = (box.maxY - box.minY) * frameHeight * 0.28;
  const x = clamp(box.minX * frameWidth - paddingX, 0, frameWidth - 1);
  const y = clamp(box.minY * frameHeight - paddingY, 0, frameHeight - 1);
  const width = clamp((box.maxX - box.minX) * frameWidth + paddingX * 2, 1, frameWidth - x);
  const height = clamp((box.maxY - box.minY) * frameHeight + paddingY * 2, 1, frameHeight - y);
  return { x, y, width, height };
};

const isPoseValidForStage = (stageKey, pose, box, blinkDetected, smileDetected) => {
  const faceWidth = box.maxX - box.minX;
  const faceHeight = box.maxY - box.minY;
  const centered = Math.abs(((box.minX + box.maxX) / 2) - FACE_GUIDE.cx) < 0.12;
  const steadyRoll = Math.abs(pose.roll) < 12;
  if (!steadyRoll) return { valid: false, feedback: 'Hold your head straight' };

  if (stageKey === 'front' && (!centered || Math.abs(pose.yaw) > 0.13 || Math.abs(pose.pitch) > 0.16)) {
    return { valid: false, feedback: centered ? 'Look straight' : 'Centre your face' };
  }
  if (stageKey === 'left' && pose.yaw > -0.09) return { valid: false, feedback: 'Turn your head slightly left' };
  if (stageKey === 'right' && pose.yaw < 0.09) return { valid: false, feedback: 'Turn your head slightly right' };
  if (stageKey === 'up' && pose.pitch > -0.08) return { valid: false, feedback: 'Look slightly upward' };
  if (stageKey === 'down' && pose.pitch < 0.09) return { valid: false, feedback: 'Look slightly downward' };
  if (stageKey === 'blink' && !blinkDetected) return { valid: false, feedback: 'Blink once' };
  if (stageKey === 'closer' && (faceWidth < 0.25 || faceHeight < 0.34)) return { valid: false, feedback: 'Move slightly closer' };
  if (stageKey === 'final' && (!centered || Math.abs(pose.yaw) > 0.11 || Math.abs(pose.pitch) > 0.14)) {
    return { valid: false, feedback: 'Final front-facing scan' };
  }
  if (stageKey === 'blink' && !smileDetected && blinkDetected) {
    return { valid: true, feedback: 'Liveness confirmed' };
  }
  return { valid: true, feedback: 'Hold still' };
};

const analyzeFaceFrame = (video, canvas, result, stage) => {
  const faces = result?.faceLandmarks || [];
  const blendshape = result?.faceBlendshapes?.[0];
  if (!faces.length) {
    return { valid: false, feedback: 'Centre your face', positionOk: false, lightingOk: false, blurOk: false, livenessOk: false };
  }
  if (faces.length > 1) {
    return { valid: false, feedback: 'Multiple faces detected', positionOk: false, lightingOk: false, blurOk: false, livenessOk: false };
  }

  const landmarks = faces[0];
  const box = getLandmarkBox(landmarks);
  const crop = getCropFromLandmarks(video, landmarks);
  const pose = getPose(landmarks);
  const faceWidth = box.maxX - box.minX;
  const faceHeight = box.maxY - box.minY;
  const insideOval = isBoxInsideOval(box);
  const tooFar = faceWidth < 0.14 || faceHeight < 0.22;
  const tooClose = faceWidth > 0.62 || faceHeight > 0.82;
  const edgeCut = box.minX < 0.03 || box.maxX > 0.97 || box.minY < 0.01 || box.maxY > 0.99;
  const quality = crop ? getImageQuality(video, canvas, crop) : { lightingOk: false, blurOk: false, brightness: 0, blurScore: 0 };
  const blinkLeft = getBlendScore(blendshape, 'eyeBlinkLeft');
  const blinkRight = getBlendScore(blendshape, 'eyeBlinkRight');
  const smileLeft = getBlendScore(blendshape, 'mouthSmileLeft');
  const smileRight = getBlendScore(blendshape, 'mouthSmileRight');
  const blinkDetected = blinkLeft > 0.45 && blinkRight > 0.45;
  const eyesClosed = blinkLeft > 0.55 && blinkRight > 0.55;
  const smileDetected = smileLeft > 0.22 || smileRight > 0.22;

  if (edgeCut || !insideOval) return { valid: false, feedback: 'Fit full face inside the oval', positionOk: false, lightingOk: quality.lightingOk, blurOk: quality.blurOk, livenessOk: false, landmarks, crop, pose, quality };
  if (tooFar) return { valid: false, feedback: 'Move closer', positionOk: false, lightingOk: quality.lightingOk, blurOk: quality.blurOk, livenessOk: false, landmarks, crop, pose, quality };
  if (tooClose) return { valid: false, feedback: 'Move backward to include forehead and chin', positionOk: false, lightingOk: quality.lightingOk, blurOk: quality.blurOk, livenessOk: false, landmarks, crop, pose, quality };
  if (!quality.lightingOk) return { valid: false, feedback: quality.brightness < 58 ? 'Improve lighting' : 'Lighting is too bright', positionOk: true, lightingOk: false, blurOk: quality.blurOk, livenessOk: false, landmarks, crop, pose, quality };
  if (!quality.blurOk) return { valid: false, feedback: 'Hold still', positionOk: true, lightingOk: true, blurOk: false, livenessOk: false, landmarks, crop, pose, quality };
  if (stage.key !== 'blink' && eyesClosed) return { valid: false, feedback: 'Open your eyes', positionOk: true, lightingOk: true, blurOk: true, livenessOk: false, landmarks, crop, pose, quality };

  const poseValidation = isPoseValidForStage(stage.key, pose, box, blinkDetected, smileDetected);
  const livenessOk = stage.key === 'blink' ? blinkDetected : true;
  return {
    valid: poseValidation.valid && livenessOk,
    feedback: poseValidation.feedback,
    positionOk: true,
    lightingOk: true,
    blurOk: true,
    livenessOk,
    landmarks,
    crop,
    pose,
    quality,
  };
};

const getFaceCrop = async (video, analysis = null) => {
  const frameWidth = video.videoWidth;
  const frameHeight = video.videoHeight;
  if (analysis?.crop) return analysis.crop;
  const fallbackCrop = {
    x: frameWidth * 0.2,
    y: frameHeight * 0.08,
    width: frameWidth * 0.6,
    height: frameHeight * 0.76,
  };

  if (!window.FaceDetector) {
    return fallbackCrop;
  }

  try {
    const detector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
    const faces = await detector.detect(video);
    const box = faces?.[0]?.boundingBox;
    if (!box) return fallbackCrop;

    const paddingX = box.width * 0.3;
    const paddingY = box.height * 0.4;
    const x = clamp(box.x - paddingX, 0, frameWidth - 1);
    const y = clamp(box.y - paddingY, 0, frameHeight - 1);
    const width = clamp(box.width + paddingX * 2, 1, frameWidth - x);
    const height = clamp(box.height + paddingY * 2, 1, frameHeight - y);
    return { x, y, width, height };
  } catch (error) {
    return fallbackCrop;
  }
};

const buildLandmarkDescriptor = (landmarks = [], pose = {}) => {
  if (!landmarks.length) return [];
  const box = getLandmarkBox(landmarks);
  const centerX = (box.minX + box.maxX) / 2;
  const centerY = (box.minY + box.maxY) / 2;
  const scale = Math.max(box.maxX - box.minX, box.maxY - box.minY, 0.001);
  const values = [];
  SELECTED_LANDMARKS.forEach((index) => {
    const point = landmarks[index];
    if (!point) return;
    values.push((point.x - centerX) / scale);
    values.push((point.y - centerY) / scale);
  });
  values.push(clamp(pose.yaw || 0, -0.5, 0.5));
  values.push(clamp(pose.pitch || 0, -0.5, 0.5));
  values.push(clamp((pose.roll || 0) / 45, -1, 1));
  return values;
};

const buildDescriptorFromVideo = async (video, canvas, analysis = null) => {
  if (!video || !canvas || !video.videoWidth) {
    throw new Error('Camera is not ready yet');
  }

  const width = 112;
  const height = 112;
  const crop = await getFaceCrop(video, analysis);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
  const image = context.getImageData(0, 0, width, height).data;
  const columns = 12;
  const rows = 12;
  const cellWidth = Math.floor(width / columns);
  const cellHeight = Math.floor(height / rows);
  const descriptor = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      let total = 0;
      let count = 0;
      for (let y = row * cellHeight; y < (row + 1) * cellHeight; y += 1) {
        for (let x = column * cellWidth; x < (column + 1) * cellWidth; x += 1) {
          const index = (y * width + x) * 4;
          total += image[index] * 0.299 + image[index + 1] * 0.587 + image[index + 2] * 0.114;
          count += 1;
        }
      }
      descriptor.push(total / count / 255);
    }
  }

  const mean = descriptor.reduce((sum, value) => sum + value, 0) / descriptor.length;
  const variance = descriptor.reduce((sum, value) => sum + (value - mean) ** 2, 0) / descriptor.length;
  const standardDeviation = Math.sqrt(variance) || 1;
  const textureDescriptor = descriptor.map((value) => Number(clamp((value - mean) / standardDeviation, -3, 3).toFixed(5)));
  const landmarkDescriptor = buildLandmarkDescriptor(analysis?.landmarks, analysis?.pose).map((value) => Number(clamp(value, -3, 3).toFixed(5)));
  return [...landmarkDescriptor, ...textureDescriptor];
};

const StatusPill = ({ label, ok }) => (
  <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-white text-slate-500'}`}>
    {ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
    {label}
  </div>
);

const ProgressRing = ({ value }) => {
  const radius = 48;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (clamp(value, 0, 100) / 100) * circumference;
  return (
    <div className="relative h-32 w-32">
      <svg className="h-full w-full -rotate-90" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={radius} fill="none" stroke="#e2e8f0" strokeWidth="10" />
        <circle
          cx="60"
          cy="60"
          r={radius}
          fill="none"
          stroke="#059669"
          strokeLinecap="round"
          strokeWidth="10"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-2xl font-bold">
        {Math.round(value)}%
      </div>
    </div>
  );
};

class AttendanceErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error('Attendance page crashed', error);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4 text-slate-950">
        <Card className="w-full max-w-md rounded-lg">
          <CardHeader>
            <CardTitle>Attendance could not load</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-slate-600">
              Something went wrong while opening attendance. Refresh once; if it repeats, check staff profiles for missing email details.
            </p>
            <Button className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-700" onClick={() => window.location.reload()}>
              <RefreshCw className="h-4 w-4" />
              Reload Attendance
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }
}

const AttendanceDashboardContent = ({ kioskOnly = false, publicKiosk = false }) => {
  const navigate = useNavigate();
  const { kioskToken } = useParams();
  const { user, logout } = useAuth();
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const faceLandmarkerRef = useRef(null);
  const faceModelPromiseRef = useRef(null);
  const registrationLoopRef = useRef(null);
  const lastAcceptedAtRef = useRef(0);
  const stageSamplesRef = useRef(createStageSamples());
  const samplesRef = useRef([]);
  const stageIndexRef = useRef(0);
  const cameraFacingModeRef = useRef('user');
  const scannerSuccessTimerRef = useRef(null);
  const isPublicKiosk = publicKiosk && Boolean(kioskToken);
  const canManage = !kioskOnly && !isPublicKiosk && MANAGER_ROLES.includes(user?.role);

  const [cameraActive, setCameraActive] = useState(false);
  const [cameraFacingMode, setCameraFacingMode] = useState('user');
  const [activeTab, setActiveTab] = useState('kiosk');
  const [loading, setLoading] = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [staff, setStaff] = useState([]);
  const [settings, setSettings] = useState(emptySettings);
  const [shifts, setShifts] = useState([]);
  const [newShift, setNewShift] = useState({
    name: '',
    shift_start: '10:00',
    shift_end: '22:00',
    grace_minutes: 10,
    overtime_after_hours: 9,
  });
  const [shiftSaving, setShiftSaving] = useState(false);
  const [restaurantName, setRestaurantName] = useState('');
  const [selectedStaffEmail, setSelectedStaffEmail] = useState('');
  const [pin, setPin] = useState('');
  const [enrollStaffEmail, setEnrollStaffEmail] = useState('');
  const [enrollShiftId, setEnrollShiftId] = useState('');
  const [enrollPin, setEnrollPin] = useState('');
  const [samples, setSamples] = useState([]);
  const [stageSamples, setStageSamples] = useState(createStageSamples);
  const [stageIndex, setStageIndex] = useState(0);
  const [registrationActive, setRegistrationActive] = useState(false);
  const [registrationComplete, setRegistrationComplete] = useState(false);
  const [registrationProgress, setRegistrationProgress] = useState(0);
  const [registrationFeedback, setRegistrationFeedback] = useState('Start registration');
  const [faceStatus, setFaceStatus] = useState({
    valid: false,
    positionOk: false,
    lightingOk: false,
    blurOk: false,
    livenessOk: false,
  });
  const [lastPunch, setLastPunch] = useState(null);
  const [scannerSuccess, setScannerSuccess] = useState(null);
  const [reportDate, setReportDate] = useState(getIndiaDate());
  const [exportFilters, setExportFilters] = useState({
    start_date: getIndiaDate(),
    end_date: getIndiaDate(),
    staff_email: 'all',
  });
  const [summary, setSummary] = useState(null);
  const [logs, setLogs] = useState([]);

  const staffWithEmail = useMemo(() => staff.filter((staffMember) => hasSelectValue(staffMember?.email)), [staff]);
  const activeStaff = useMemo(() => staffWithEmail.filter((staffMember) => staffMember.attendance_active), [staffWithEmail]);
  const activeShifts = useMemo(() => shifts.filter((shift) => shift.active !== false), [shifts]);

  useEffect(() => {
    samplesRef.current = samples;
  }, [samples]);

  useEffect(() => {
    stageSamplesRef.current = stageSamples;
    const progress = calculateRegistrationProgress(stageSamples);
    const currentStageIndex = findCurrentStageIndex(stageSamples);
    setRegistrationProgress(progress);
    setStageIndex(currentStageIndex);
    stageIndexRef.current = currentStageIndex;
    if (progress >= 100) {
      setRegistrationActive(false);
      setRegistrationComplete(true);
      setRegistrationFeedback('Face registration completed successfully.');
    }
  }, [stageSamples]);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
  }, []);

  const waitForVideoReady = useCallback((video) => new Promise((resolve, reject) => {
    if (!video) {
      reject(new Error('Camera preview is not ready'));
      return;
    }
    if (video.videoWidth > 0 && video.readyState >= 2) {
      resolve();
      return;
    }

    let settled = false;
    let timeoutId;
    function cleanup() {
      window.clearTimeout(timeoutId);
      video.removeEventListener('loadedmetadata', handleReady);
      video.removeEventListener('canplay', handleReady);
    }
    function handleReady() {
      if (video.videoWidth > 0 && !settled) {
        settled = true;
        cleanup();
        resolve();
      }
    }
    timeoutId = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error('Camera is still loading. Please try again.'));
      }
    }, 2500);

    video.addEventListener('loadedmetadata', handleReady);
    video.addEventListener('canplay', handleReady);
  }), []);

  const attachStreamToVideo = useCallback(async (stream) => {
    if (!videoRef.current || !stream) return false;
    if (videoRef.current.srcObject !== stream) {
      videoRef.current.srcObject = stream;
    }
    await videoRef.current.play();
    await waitForVideoReady(videoRef.current);
    return true;
  }, [waitForVideoReady]);

  const loadFaceModel = useCallback(async () => {
    if (faceLandmarkerRef.current) return faceLandmarkerRef.current;
    if (!faceModelPromiseRef.current) {
      setModelLoading(true);
      faceModelPromiseRef.current = FilesetResolver.forVisionTasks(FACE_LANDMARKER_WASM_URL)
        .then(async (vision) => {
          const options = {
            baseOptions: {
              modelAssetPath: FACE_LANDMARKER_MODEL_URL,
              delegate: 'GPU',
            },
            runningMode: 'VIDEO',
            numFaces: 2,
            outputFaceBlendshapes: true,
          };
          try {
            return await FaceLandmarker.createFromOptions(vision, options);
          } catch (error) {
            return FaceLandmarker.createFromOptions(vision, {
              ...options,
              baseOptions: { modelAssetPath: FACE_LANDMARKER_MODEL_URL },
            });
          }
        })
        .then((landmarker) => {
          faceLandmarkerRef.current = landmarker;
          return landmarker;
        })
        .catch((error) => {
          faceModelPromiseRef.current = null;
          throw error;
        })
        .finally(() => setModelLoading(false));
    }
    return faceModelPromiseRef.current;
  }, []);

  const analyzeCurrentFrame = useCallback(async (stage = REGISTRATION_STAGES[0]) => {
    const ready = videoRef.current && canvasRef.current && videoRef.current.videoWidth > 0;
    if (!ready) {
      return { valid: false, feedback: 'Camera is not ready yet', positionOk: false, lightingOk: false, blurOk: false, livenessOk: false };
    }
    try {
      const landmarker = await loadFaceModel();
      const result = landmarker.detectForVideo(videoRef.current, performance.now());
      return analyzeFaceFrame(videoRef.current, canvasRef.current, result, stage);
    } catch (error) {
      return { valid: false, feedback: 'Face model is loading', positionOk: false, lightingOk: false, blurOk: false, livenessOk: false };
    }
  }, [loadFaceModel]);

  const startCamera = useCallback(async (mode = cameraFacingModeRef.current) => {
    if (streamRef.current) {
      try {
        await attachStreamToVideo(streamRef.current);
        setCameraActive(true);
        return true;
      } catch (error) {
        toast.error(error.message || 'Camera is not ready yet');
        return false;
      }
    }

    try {
      const mobilePortrait = typeof window !== 'undefined' && window.innerWidth < 640;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: mode,
          width: { ideal: mobilePortrait ? 720 : 960 },
          height: { ideal: mobilePortrait ? 960 : 720 },
        },
        audio: false,
      });
      streamRef.current = stream;
      cameraFacingModeRef.current = mode;
      setCameraFacingMode(mode);
      await attachStreamToVideo(stream);
      setCameraActive(true);
      return true;
    } catch (error) {
      toast.error('Camera access failed. Check browser permission.');
      return false;
    }
  }, [attachStreamToVideo]);

  useEffect(() => {
    if (!kioskOnly || activeTab !== 'kiosk') return;
    startCamera();
  }, [activeTab, kioskOnly, startCamera]);

  const ensureCameraReady = useCallback(async () => {
    if (!streamRef.current) {
      return startCamera();
    }
    try {
      await attachStreamToVideo(streamRef.current);
      setCameraActive(true);
      return true;
    } catch (error) {
      toast.error(error.message || 'Camera is not ready yet');
      return false;
    }
  }, [attachStreamToVideo, startCamera]);

  const switchCamera = useCallback(async () => {
    const nextMode = cameraFacingModeRef.current === 'user' ? 'environment' : 'user';
    stopCamera();
    cameraFacingModeRef.current = nextMode;
    setCameraFacingMode(nextMode);
    await startCamera(nextMode);
  }, [startCamera, stopCamera]);

  const captureDescriptor = useCallback(async () => {
    const ready = await ensureCameraReady();
    if (!ready) return null;
    try {
      const analysis = await analyzeCurrentFrame(REGISTRATION_STAGES[0]);
      if (!analysis.valid) {
        toast.error(analysis.feedback || 'Face not detected');
        return null;
      }
      return await buildDescriptorFromVideo(videoRef.current, canvasRef.current, analysis);
    } catch (error) {
      toast.error(error.message || 'Unable to capture face sample');
      return null;
    }
  }, [analyzeCurrentFrame, ensureCameraReady]);

  const loadReports = useCallback(async () => {
    if (!canManage) return;
    try {
      const [summaryResponse, logsResponse] = await Promise.all([
        api.get(`/api/attendance/summary?date=${reportDate}`),
        api.get(`/api/attendance/logs?date=${reportDate}`),
      ]);
      setSummary(summaryResponse.data);
      setLogs(logsResponse.data);
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to load attendance reports');
    }
  }, [canManage, reportDate]);

  const loadAttendance = useCallback(async () => {
    try {
      if (isPublicKiosk) {
        const response = await api.get(`/api/public/attendance-kiosk/${encodeURIComponent(kioskToken)}`);
        setRestaurantName(response.data.restaurant_name || 'Restaurant');
        setSettings({ ...emptySettings, ...(response.data.settings || {}) });
        setStaff([]);
        setShifts([]);
        return;
      }
      const [settingsResponse, staffResponse, shiftsResponse] = await Promise.all([
        api.get('/api/attendance/settings'),
        api.get('/api/attendance/staff'),
        api.get('/api/attendance/shifts'),
      ]);
      setSettings({ ...emptySettings, ...(settingsResponse.data.settings || {}) });
      const staffList = (staffResponse.data || []).filter((staffMember) => hasSelectValue(staffMember?.email));
      const shiftList = shiftsResponse.data || [];
      setStaff(staffList);
      setShifts(shiftList);
      if (!selectedStaffEmail && staffList.length) setSelectedStaffEmail(staffList[0].email);
      if (!enrollStaffEmail && staffList.length) setEnrollStaffEmail(staffList[0].email);
      if (!enrollShiftId && shiftList.length) {
        const assignedShift = staffList.find((item) => item.email === (enrollStaffEmail || staffList[0]?.email))?.shift_id;
        setEnrollShiftId(assignedShift || shiftList.find((shift) => shift.active !== false)?.shift_id || '');
      }
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to load attendance data');
    }
  }, [enrollShiftId, enrollStaffEmail, isPublicKiosk, kioskToken, selectedStaffEmail]);

  useEffect(() => {
    loadAttendance();
  }, [loadAttendance]);

  useEffect(() => {
    if (!enrollStaffEmail || !shifts.length) return;
    const assignedShift = staff.find((staffMember) => staffMember.email === enrollStaffEmail)?.shift_id;
    setEnrollShiftId(assignedShift || shifts.find((shift) => shift.active !== false)?.shift_id || '');
  }, [enrollStaffEmail, shifts, staff]);

  useEffect(() => {
    loadReports();
  }, [loadReports]);

  useEffect(() => () => {
    stopCamera();
    if (scannerSuccessTimerRef.current) {
      window.clearTimeout(scannerSuccessTimerRef.current);
    }
  }, [stopCamera]);

  useEffect(() => {
    if (!['kiosk', 'enroll'].includes(activeTab)) {
      stopCamera();
      return;
    }
    if (streamRef.current) {
      attachStreamToVideo(streamRef.current).catch(() => {
        setCameraActive(false);
      });
    }
  }, [activeTab, attachStreamToVideo, stopCamera]);

  const resetRegistration = useCallback((keepCamera = true) => {
    const initialStageSamples = createStageSamples();
    setSamples([]);
    setStageSamples(initialStageSamples);
    setRegistrationActive(false);
    setRegistrationComplete(false);
    setRegistrationProgress(0);
    setRegistrationFeedback('Start registration');
    setFaceStatus({
      valid: false,
      positionOk: false,
      lightingOk: false,
      blurOk: false,
      livenessOk: false,
    });
    stageSamplesRef.current = initialStageSamples;
    samplesRef.current = [];
    stageIndexRef.current = 0;
    lastAcceptedAtRef.current = 0;
    if (!keepCamera) stopCamera();
  }, [stopCamera]);

  const startRegistration = useCallback(async () => {
    resetRegistration(true);
    const ready = await ensureCameraReady();
    if (!ready) return;
    try {
      await loadFaceModel();
      setRegistrationActive(true);
      setRegistrationFeedback(REGISTRATION_STAGES[0].instruction);
    } catch (error) {
      toast.error('Face model could not load. Check internet connection and reload.');
    }
  }, [ensureCameraReady, loadFaceModel, resetRegistration]);

  const acceptRegistrationSample = useCallback(async (analysis) => {
    const now = performance.now();
    if (now - lastAcceptedAtRef.current < 850) return;
    const descriptor = await buildDescriptorFromVideo(videoRef.current, canvasRef.current, analysis);
    const duplicateScore = samplesRef.current.reduce((bestScore, existing) => Math.max(bestScore, cosineSimilarity(existing, descriptor)), 0);
    if (duplicateScore > 0.995) {
      setRegistrationFeedback('Hold a slightly different position');
      return;
    }

    lastAcceptedAtRef.current = now;
    setSamples((current) => [...current, descriptor]);
    setStageSamples((current) => {
      const next = current.map((items) => [...items]);
      const currentStageIndex = findCurrentStageIndex(next);
      const stage = REGISTRATION_STAGES[currentStageIndex];
      if (!stage || next[currentStageIndex].length >= stage.samples) return current;
      next[currentStageIndex].push({
        timestamp: new Date().toISOString(),
        pose: analysis.pose,
        quality: analysis.quality,
      });
      const progress = calculateRegistrationProgress(next);
      const nextStageIndex = findCurrentStageIndex(next);
      const nextStage = REGISTRATION_STAGES[nextStageIndex];
      if (progress >= 100) {
        setRegistrationFeedback('Face registration completed successfully.');
      } else if (nextStageIndex !== currentStageIndex) {
        setRegistrationFeedback(nextStage.instruction);
      } else {
        setRegistrationFeedback(analysis.feedback || stage.instruction);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!registrationActive || activeTab !== 'enroll' || !cameraActive) return undefined;
    let cancelled = false;

    const runAnalysis = async () => {
      if (cancelled) return;
      const stage = REGISTRATION_STAGES[stageIndexRef.current] || REGISTRATION_STAGES[REGISTRATION_STAGES.length - 1];
      const analysis = await analyzeCurrentFrame(stage);
      if (cancelled) return;
      setFaceStatus(analysis);
      if (!analysis.valid) {
        setRegistrationFeedback(analysis.feedback || stage.instruction);
      } else {
        setRegistrationFeedback(analysis.feedback || stage.instruction);
        await acceptRegistrationSample(analysis);
      }
      registrationLoopRef.current = window.requestAnimationFrame(runAnalysis);
    };

    registrationLoopRef.current = window.requestAnimationFrame(runAnalysis);
    return () => {
      cancelled = true;
      if (registrationLoopRef.current) {
        window.cancelAnimationFrame(registrationLoopRef.current);
        registrationLoopRef.current = null;
      }
    };
  }, [acceptRegistrationSample, activeTab, analyzeCurrentFrame, cameraActive, registrationActive]);

  const submitPunch = async (punchType, method) => {
    if (isPublicKiosk && method !== 'face') {
      toast.error('Public kiosk supports face scan only');
      return;
    }
    const payload = { punch_type: punchType, method };
    if (method === 'face') {
      const descriptor = await captureDescriptor();
      if (!descriptor) return;
      payload.descriptor = descriptor;
    } else {
      if (!selectedStaffEmail || !pin.trim()) {
        toast.error('Select staff and enter PIN');
        return;
      }
      payload.staff_email = selectedStaffEmail;
      payload.pin = pin.trim();
    }

    try {
      setLoading(true);
      const endpoint = isPublicKiosk
        ? `/api/public/attendance-kiosk/${encodeURIComponent(kioskToken)}/punch`
        : '/api/attendance/punch';
      const response = await api.post(endpoint, payload);
      const successPayload = {
        staffName: response.data.staff?.name || 'Staff',
        message: getPunchSuccessMessage(response.data.event),
        timestamp: getPunchTimestamp(response.data),
      };
      setLastPunch(response.data);
      setScannerSuccess(successPayload);
      if (scannerSuccessTimerRef.current) {
        window.clearTimeout(scannerSuccessTimerRef.current);
      }
      scannerSuccessTimerRef.current = window.setTimeout(() => {
        setScannerSuccess((current) => (current?.timestamp === successPayload.timestamp ? null : current));
      }, 8000);
      setPin('');
      toast.success(`${response.data.staff?.name || 'Staff'} attendance updated`);
      await Promise.all([loadAttendance(), loadReports()]);
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Attendance punch failed');
    } finally {
      setLoading(false);
    }
  };

  const saveEnrollment = async () => {
    if (!enrollStaffEmail) {
      toast.error('Select staff member');
      return;
    }
    if (!registrationComplete || registrationProgress < 100) {
      toast.error('Complete face registration before saving');
      return;
    }
    try {
      setLoading(true);
      await api.post('/api/attendance/enroll', {
        staff_email: enrollStaffEmail,
        descriptors: samples,
        pin: enrollPin.trim() || undefined,
        active: true,
        shift_id: enrollShiftId || undefined,
        registration_audit: {
          completed_at: new Date().toISOString(),
          embedding_version: 'mediapipe_landmark_texture_v2',
          stages: REGISTRATION_STAGES.map((stage, index) => ({
            key: stage.key,
            instruction: stage.instruction,
            accepted_samples: stageSamples[index]?.length || 0,
          })),
          samples_count: samples.length,
          raw_frames_stored: false,
        },
      });
      toast.success('Attendance profile saved');
      resetRegistration(true);
      setEnrollPin('');
      await loadAttendance();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to save profile');
    } finally {
      setLoading(false);
    }
  };

  const createShift = async () => {
    if (!newShift.name.trim()) {
      toast.error('Enter shift name');
      return;
    }
    try {
      setShiftSaving(true);
      await api.post('/api/attendance/shifts', {
        name: newShift.name.trim(),
        shift_start: newShift.shift_start,
        shift_end: newShift.shift_end,
        grace_minutes: Number(newShift.grace_minutes),
        overtime_after_hours: Number(newShift.overtime_after_hours),
        active: true,
      });
      setNewShift({
        name: '',
        shift_start: settings.shift_start,
        shift_end: settings.shift_end,
        grace_minutes: settings.grace_minutes,
        overtime_after_hours: settings.overtime_after_hours,
      });
      toast.success('Shift created');
      await loadAttendance();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to create shift');
    } finally {
      setShiftSaving(false);
    }
  };

  const updateShift = async (shift, patch) => {
    try {
      setShiftSaving(true);
      await api.put(`/api/attendance/shifts/${encodeURIComponent(shift.shift_id)}`, {
        name: shift.name,
        shift_start: shift.shift_start,
        shift_end: shift.shift_end,
        grace_minutes: Number(shift.grace_minutes),
        overtime_after_hours: Number(shift.overtime_after_hours),
        active: shift.active !== false,
        ...patch,
      });
      toast.success('Shift updated');
      await loadAttendance();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to update shift');
    } finally {
      setShiftSaving(false);
    }
  };

  const assignShift = async (staffEmail, shiftId) => {
    try {
      await api.post('/api/attendance/profile-shift', {
        staff_email: staffEmail,
        shift_id: shiftId === 'default' ? null : shiftId,
      });
      toast.success('Shift assigned');
      await loadAttendance();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to assign shift');
    }
  };

  const exportAttendance = async () => {
    try {
      const params = new URLSearchParams({
        start_date: exportFilters.start_date,
        end_date: exportFilters.end_date,
      });
      if (exportFilters.staff_email !== 'all') {
        params.set('staff_email', exportFilters.staff_email);
      }
      const response = await api.get(`/api/attendance/export?${params.toString()}`, { responseType: 'blob' });
      const blob = new Blob([response.data], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `attendance-${exportFilters.start_date}-to-${exportFilters.end_date}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      toast.success('Attendance Excel exported');
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to export attendance');
    }
  };

  const saveSettings = async () => {
    try {
      setLoading(true);
      const response = await api.put('/api/attendance/settings', {
        ...settings,
        grace_minutes: Number(settings.grace_minutes),
        overtime_after_hours: Number(settings.overtime_after_hours),
        confidence_threshold: Number(settings.confidence_threshold),
      });
      setSettings(response.data.settings);
      toast.success('Attendance settings saved');
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to save settings');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    if (isPublicKiosk) return;
    await logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-slate-100 text-slate-950">
      <header className="sticky top-0 z-20 border-b bg-white">
        <div className={`mx-auto flex max-w-7xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 ${isPublicKiosk ? 'px-3 py-3' : ''}`}>
          <div className="flex items-center gap-3">
            <div className={`${isPublicKiosk ? 'h-10 w-10' : 'h-11 w-11'} flex items-center justify-center rounded-xl bg-emerald-100 text-emerald-700`}>
              <UserCheck className={`${isPublicKiosk ? 'h-5 w-5' : 'h-6 w-6'}`} />
            </div>
            <div>
              <h1 className={`${isPublicKiosk ? 'text-lg' : 'text-xl'} font-bold tracking-tight sm:text-2xl`}>{kioskOnly ? 'Attendance Kiosk' : 'Attendance'}</h1>
              <p className="text-sm text-slate-500">
                {isPublicKiosk ? `${restaurantName || 'Restaurant'} · Entrance scanner` : kioskOnly ? 'Entrance scanner' : `${user?.name} · ${roleLabel(user?.role)}`}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" className="rounded-lg" onClick={loadAttendance}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
            {!isPublicKiosk && (
              <Button variant="outline" className="rounded-lg" onClick={handleLogout}>
                <LogOut className="h-4 w-4" />
                Logout
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className={`mx-auto space-y-5 px-4 py-5 sm:px-6 ${kioskOnly ? 'max-w-5xl' : 'max-w-7xl'} ${isPublicKiosk ? 'space-y-3 px-3 py-3 sm:space-y-5 sm:px-6 sm:py-5' : ''}`}>
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          {!kioskOnly && (
            <TabsList className={`grid h-auto w-full rounded-xl border bg-white p-1 ${canManage ? 'grid-cols-4' : 'grid-cols-1'}`}>
              <TabsTrigger value="kiosk" className="rounded-lg">
                <Camera className="mr-2 h-4 w-4" />
                Kiosk
              </TabsTrigger>
              {canManage && (
                <>
                  <TabsTrigger value="enroll" className="rounded-lg">
                    <ShieldCheck className="mr-2 h-4 w-4" />
                    Enroll
                  </TabsTrigger>
                  <TabsTrigger value="reports" className="rounded-lg">
                    <CalendarDays className="mr-2 h-4 w-4" />
                    Reports
                  </TabsTrigger>
                  <TabsTrigger value="settings" className="rounded-lg">
                    <Settings className="mr-2 h-4 w-4" />
                    Settings
                  </TabsTrigger>
                </>
              )}
            </TabsList>
          )}

          {['kiosk', 'enroll'].includes(activeTab) && (
            <Card className="rounded-lg">
              <CardHeader className="p-3 sm:p-4">
                <CardTitle className="flex items-center justify-between text-base sm:text-lg">
                  Camera
                  <Badge className={cameraActive ? 'bg-emerald-600' : 'bg-slate-500'}>
                    {cameraActive ? 'Camera On' : 'Camera Off'}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 p-3 pt-0 sm:p-4 sm:pt-0">
                <div className={`relative mx-auto w-full overflow-hidden rounded-xl border bg-slate-950 ${kioskOnly ? 'aspect-[3/4] max-h-[58svh] max-w-[430px] sm:aspect-[4/3] sm:max-h-none sm:max-w-4xl' : 'aspect-[4/3] max-w-3xl'}`}>
                  <video
                    ref={videoRef}
                    className="h-full w-full object-cover"
                    muted
                    playsInline
                    style={{ transform: cameraFacingMode === 'user' ? 'scaleX(-1)' : 'none' }}
                  />
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className={`h-[84%] w-[62%] rounded-[50%] border-[3px] sm:h-[86%] sm:w-[60%] sm:border-4 ${faceStatus.valid ? 'border-emerald-400' : 'border-white/80'} shadow-[0_0_0_999px_rgba(15,23,42,0.35)]`} />
                  </div>
                  {activeTab === 'enroll' && (
                    <div className="absolute left-3 right-3 top-3 rounded-lg bg-slate-950/70 px-3 py-2 text-center text-sm font-semibold text-white">
                      {REGISTRATION_STAGES[stageIndex]?.instruction || 'Face registration completed successfully.'}
                    </div>
                  )}
                  {activeTab === 'kiosk' && scannerSuccess && (
                    <div className="pointer-events-none absolute inset-x-3 bottom-3 rounded-xl border border-emerald-200 bg-emerald-50/95 p-3 text-emerald-950 shadow-2xl backdrop-blur sm:inset-x-4 sm:bottom-4 sm:p-4">
                      <div className="flex items-start gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white sm:h-11 sm:w-11">
                          <CheckCircle2 className="h-6 w-6" />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-base font-bold sm:text-lg">{scannerSuccess.staffName}</p>
                          <p className="text-sm font-semibold sm:text-base">Saved: {scannerSuccess.message}</p>
                          <p className="text-xs font-medium text-emerald-700 sm:text-sm">{formatDateTime(scannerSuccess.timestamp)}</p>
                        </div>
                      </div>
                    </div>
                  )}
                  <canvas ref={canvasRef} className="hidden" />
                </div>
                <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                  <Button onClick={startCamera} className="rounded-lg bg-emerald-600 hover:bg-emerald-700">
                    <Camera className="h-4 w-4" />
                    Start Camera
                  </Button>
                  <Button onClick={switchCamera} variant="outline" className="rounded-lg">
                    <RotateCcw className="h-4 w-4" />
                    Switch Camera
                  </Button>
                  <Button onClick={stopCamera} variant="outline" className="rounded-lg max-sm:col-span-2">
                    Stop Camera
                  </Button>
                  {registrationActive && (
                    <Button onClick={() => setRegistrationActive(false)} variant="outline" className="rounded-lg">
                      Cancel
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          <TabsContent value="kiosk" className="space-y-4">
            <div className="space-y-4">
              <div className={`grid gap-4 ${isPublicKiosk ? 'mx-auto max-w-3xl lg:grid-cols-1' : 'lg:grid-cols-2'}`}>
                <Card className="rounded-lg">
                  <CardHeader className="p-4">
                    <CardTitle className="text-lg">{isPublicKiosk ? 'Face Attendance' : 'Face Punch'}</CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-2 p-4 pt-0 sm:grid-cols-2">
                    {ACTIONS.map((action) => {
                      const Icon = action.icon;
                      return (
                        <Button
                          key={action.value}
                          disabled={loading}
                          onClick={() => submitPunch(action.value, 'face')}
                          className={`h-14 rounded-lg text-base ${action.className}`}
                        >
                          <Icon className="h-5 w-5" />
                          {action.label}
                        </Button>
                      );
                    })}
                  </CardContent>
                </Card>

                {!isPublicKiosk && (
                  <Card className="rounded-lg">
                    <CardHeader className="p-4">
                      <CardTitle className="text-lg">PIN Backup</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 p-4 pt-0">
                      <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
                        <Select value={selectedStaffEmail} onValueChange={setSelectedStaffEmail}>
                          <SelectTrigger className="rounded-lg">
                            <SelectValue placeholder="Select staff" />
                          </SelectTrigger>
                          <SelectContent>
                            {(activeStaff.length ? activeStaff : staffWithEmail).map((staffMember) => (
                              <SelectItem key={staffMember.email} value={staffMember.email}>
                                {staffMember.name} · {roleLabel(staffMember.role)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input
                          value={pin}
                          onChange={(event) => setPin(event.target.value)}
                          className="rounded-lg"
                          placeholder="PIN"
                          type="password"
                        />
                      </div>
                      <div className="grid gap-2 sm:grid-cols-4">
                        {ACTIONS.map((action) => (
                          <Button
                            key={`pin-${action.value}`}
                            disabled={loading}
                            onClick={() => submitPunch(action.value, 'pin')}
                            variant="outline"
                            className="h-11 rounded-lg"
                          >
                            {action.label}
                          </Button>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>

              {lastPunch && (
	                <Card className="rounded-lg border-emerald-200 bg-emerald-50">
	                  <CardContent className="space-y-1 p-4">
	                    <p className="font-semibold text-emerald-900">{lastPunch.staff?.name}</p>
	                    <p className="text-sm text-emerald-800">
	                      {getPunchSuccessMessage(lastPunch.event)} · {formatDateTime(getPunchTimestamp(lastPunch))}
	                    </p>
	                    <p className="text-xs font-medium text-emerald-700">
	                      Confidence {lastPunch.confidence ? `${Math.round(lastPunch.confidence * 100)}%` : 'manual'}
	                    </p>
	                  </CardContent>
	                </Card>
              )}
            </div>
          </TabsContent>

          {canManage && (
            <TabsContent value="enroll" className="space-y-4">
              <div className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
                <Card className="rounded-lg">
                  <CardHeader className="p-4">
                    <CardTitle className="text-lg">Face Enrollment</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4 p-4 pt-0">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="space-y-2">
                        <Label>Staff</Label>
                        <select
                          value={enrollStaffEmail}
                          onChange={(event) => setEnrollStaffEmail(event.target.value)}
                          disabled={!staffWithEmail.length}
                          className="flex h-10 w-full rounded-lg border border-input bg-white px-3 py-2 text-sm shadow-sm outline-none ring-offset-background focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {!staffWithEmail.length && <option value="">No staff found</option>}
                          {staffWithEmail.map((staffMember) => (
                            <option key={staffMember.email} value={staffMember.email}>
                              {staffMember.name} - {roleLabel(staffMember.role)}
                            </option>
                          ))}
                        </select>
                        {!staffWithEmail.length && (
                          <p className="text-xs text-slate-500">Create staff from Admin &gt; Staff first, then refresh attendance.</p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <Label>Shift</Label>
                        <select
                          value={enrollShiftId}
                          onChange={(event) => setEnrollShiftId(event.target.value)}
                          disabled={!activeShifts.length}
                          className="flex h-10 w-full rounded-lg border border-input bg-white px-3 py-2 text-sm shadow-sm outline-none ring-offset-background focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {!activeShifts.length && <option value="">No shifts found</option>}
                          {activeShifts.map((shift) => (
                            <option key={shift.shift_id} value={shift.shift_id}>
                              {shift.name} ({shift.shift_start}-{shift.shift_end})
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-2">
                        <Label>PIN</Label>
                        <Input
                          value={enrollPin}
                          onChange={(event) => setEnrollPin(event.target.value)}
                          className="rounded-lg"
                          placeholder="Optional"
                          type="password"
                        />
                      </div>
                    </div>
                    <div className="grid gap-4 md:grid-cols-[auto_1fr] md:items-center">
                      <ProgressRing value={registrationProgress} />
                      <div className="space-y-3">
                        <div>
                          <p className="text-sm font-semibold text-slate-500">Current instruction</p>
                          <p className="text-2xl font-bold">{registrationFeedback}</p>
                          <p className="text-sm text-slate-500">
                            {samples.length} accepted samples · Stage {Math.min(stageIndex + 1, REGISTRATION_STAGES.length)} of {REGISTRATION_STAGES.length}
                          </p>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          <StatusPill label="Face position" ok={faceStatus.positionOk} />
                          <StatusPill label="Lighting" ok={faceStatus.lightingOk} />
                          <StatusPill label="Sharp image" ok={faceStatus.blurOk} />
                          <StatusPill label="Liveness" ok={faceStatus.livenessOk} />
                        </div>
                      </div>
                    </div>

                    {registrationComplete && (
                      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-900">
                        <p className="flex items-center gap-2 font-bold">
                          <CheckCircle2 className="h-5 w-5" />
                          Face registration completed successfully.
                        </p>
                        <p className="mt-1 text-sm">Profile preview: {staffWithEmail.find((item) => item.email === enrollStaffEmail)?.name || enrollStaffEmail}</p>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                      {!registrationActive && !registrationComplete && (
                        <Button onClick={startRegistration} disabled={modelLoading} className="rounded-lg bg-emerald-600 hover:bg-emerald-700">
                          <Camera className="h-4 w-4" />
                          {modelLoading ? 'Loading Model...' : 'Start Registration'}
                        </Button>
                      )}
                      <Button onClick={() => resetRegistration(true)} variant="outline" className="rounded-lg">
                        <RotateCcw className="h-4 w-4" />
                        Restart
                      </Button>
                      <Button onClick={() => resetRegistration(true)} variant="outline" className="rounded-lg">
                        Retake
                      </Button>
                      <Button disabled={loading || !registrationComplete} onClick={saveEnrollment} className="rounded-lg bg-emerald-600 hover:bg-emerald-700">
                        <Save className="h-4 w-4" />
                        Continue
                      </Button>
                    </div>
                  </CardContent>
                </Card>

                <Card className="rounded-lg">
                  <CardHeader className="p-4">
                    <CardTitle className="text-lg">Staff Profiles</CardTitle>
                  </CardHeader>
                  <CardContent className="max-h-[420px] overflow-auto p-4 pt-0">
                    <div className="grid gap-2">
                      {staffWithEmail.map((staffMember) => (
                        <div key={staffMember.email} className="grid gap-3 rounded-lg border p-3 lg:grid-cols-[1fr_240px_auto] lg:items-center">
                          <div>
                            <p className="font-semibold">{staffMember.name}</p>
                            <p className="text-sm text-slate-500">{staffMember.email} · {roleLabel(staffMember.role)}</p>
                            <p className="text-xs text-slate-500">Shift: {staffMember.shift_name || 'Default shift'}</p>
                          </div>
                          <select
                            value={staffMember.shift_id || 'default'}
                            onChange={(event) => assignShift(staffMember.email, event.target.value)}
                            className="flex h-10 w-full rounded-lg border border-input bg-white px-3 py-2 text-sm shadow-sm outline-none ring-offset-background focus:ring-1 focus:ring-ring"
                          >
                            <option value="default">Default shift</option>
                            {activeShifts.map((shift) => (
                              <option key={shift.shift_id} value={shift.shift_id}>
                                {shift.name} ({shift.shift_start}-{shift.shift_end})
                              </option>
                            ))}
                          </select>
                          <div className="flex flex-wrap gap-2 lg:justify-end">
                            <Badge className={staffMember.face_enrolled ? 'bg-emerald-600' : 'bg-slate-500'}>
                              {staffMember.face_enrolled ? 'Face saved' : 'No face'}
                            </Badge>
                            {staffMember.pin_enabled && <Badge variant="outline">PIN</Badge>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>
          )}

          {canManage && (
            <TabsContent value="reports" className="space-y-4">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  <Input value={reportDate} onChange={(event) => setReportDate(event.target.value)} type="date" className="w-[180px] rounded-lg" />
                  <Button onClick={loadReports} variant="outline" className="rounded-lg">
                    <RefreshCw className="h-4 w-4" />
                    Refresh
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-white p-2">
                  <Input
                    value={exportFilters.start_date}
                    onChange={(event) => setExportFilters({ ...exportFilters, start_date: event.target.value })}
                    type="date"
                    className="w-[160px] rounded-lg"
                  />
                  <Input
                    value={exportFilters.end_date}
                    onChange={(event) => setExportFilters({ ...exportFilters, end_date: event.target.value })}
                    type="date"
                    className="w-[160px] rounded-lg"
                  />
                  <select
                    value={exportFilters.staff_email}
                    onChange={(event) => setExportFilters({ ...exportFilters, staff_email: event.target.value })}
                    className="flex h-10 min-w-[190px] rounded-lg border border-input bg-white px-3 py-2 text-sm shadow-sm outline-none ring-offset-background focus:ring-1 focus:ring-ring"
                  >
                    <option value="all">All staff</option>
                    {staffWithEmail.map((staffMember) => (
                      <option key={staffMember.email} value={staffMember.email}>
                        {staffMember.name}
                      </option>
                    ))}
                  </select>
                  <Button onClick={exportAttendance} className="rounded-lg bg-emerald-600 hover:bg-emerald-700">
                    <Download className="h-4 w-4" />
                    Export Excel
                  </Button>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                {[
                  ['Staff', summary?.staff_count || 0],
                  ['Present', summary?.present_count || 0],
                  ['Absent', summary?.absent_count || 0],
                  ['Late', summary?.late_count || 0],
                  ['Hours', summary?.total_work_hours || 0],
                ].map(([label, value]) => (
                  <Card key={label} className="rounded-lg">
                    <CardContent className="p-4">
                      <p className="text-sm text-slate-500">{label}</p>
                      <p className="mt-1 text-2xl font-bold">{value}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>

              <Card className="rounded-lg">
                <CardHeader className="p-4">
                  <CardTitle className="text-lg">Daily Logs</CardTitle>
                </CardHeader>
                <CardContent className="overflow-auto p-0">
                  <table className="w-full min-w-[1000px] text-left text-sm">
                    <thead className="border-y bg-slate-50 text-xs uppercase text-slate-500">
                      <tr>
                        <th className="px-4 py-3">Staff</th>
                        <th className="px-4 py-3">Shift</th>
                        <th className="px-4 py-3">Clock In</th>
                        <th className="px-4 py-3">Clock Out</th>
                        <th className="px-4 py-3">Break</th>
                        <th className="px-4 py-3">Worked</th>
                        <th className="px-4 py-3">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logs.map((log) => (
                        <tr key={log.attendance_id} className="border-b">
                          <td className="px-4 py-3">
                            <p className="font-semibold">{log.staff_name}</p>
                            <p className="text-xs text-slate-500">{roleLabel(log.staff_role)}</p>
                          </td>
                          <td className="px-4 py-3">
                            <p className="font-medium">{log.shift_name || 'General Shift'}</p>
                            <p className="text-xs text-slate-500">{log.shift_start || '-'} - {log.shift_end || '-'}</p>
                          </td>
                          <td className="px-4 py-3">{formatDateTime(log.clock_in)}</td>
                          <td className="px-4 py-3">{formatDateTime(log.clock_out)}</td>
                          <td className="px-4 py-3">{formatMinutes(log.total_break_minutes)}</td>
                          <td className="px-4 py-3">{formatMinutes(log.total_work_minutes)}</td>
                          <td className="px-4 py-3">
                            <div className="flex gap-2">
                              <Badge className={log.status === 'active' ? 'bg-emerald-600' : 'bg-slate-700'}>
                                {log.status}
                              </Badge>
                              {log.is_late && <Badge className="bg-amber-600">Late</Badge>}
                            </div>
                          </td>
                        </tr>
                      ))}
                      {!logs.length && (
                        <tr>
                          <td className="px-4 py-8 text-center text-slate-500" colSpan={7}>No attendance logs for this date</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </TabsContent>
          )}

          {canManage && (
            <TabsContent value="settings" className="space-y-4">
              <Card className="rounded-lg">
                <CardHeader className="p-4">
                  <CardTitle className="text-lg">Attendance Settings</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4 p-4 pt-0 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Shift Start</Label>
                    <Input value={settings.shift_start} onChange={(event) => setSettings({ ...settings, shift_start: event.target.value })} type="time" className="rounded-lg" />
                  </div>
                  <div className="space-y-2">
                    <Label>Shift End</Label>
                    <Input value={settings.shift_end} onChange={(event) => setSettings({ ...settings, shift_end: event.target.value })} type="time" className="rounded-lg" />
                  </div>
                  <div className="space-y-2">
                    <Label>Grace Minutes</Label>
                    <Input value={settings.grace_minutes} onChange={(event) => setSettings({ ...settings, grace_minutes: event.target.value })} type="number" className="rounded-lg" />
                  </div>
                  <div className="space-y-2">
                    <Label>Overtime After Hours</Label>
                    <Input value={settings.overtime_after_hours} onChange={(event) => setSettings({ ...settings, overtime_after_hours: event.target.value })} type="number" className="rounded-lg" />
                  </div>
                  <div className="space-y-2">
                    <Label>Face Confidence Threshold</Label>
                    <Input
                      value={settings.confidence_threshold}
                      onChange={(event) => setSettings({ ...settings, confidence_threshold: event.target.value })}
                      max="0.99"
                      min="0.55"
                      step="0.01"
                      type="number"
                      className="rounded-lg"
                    />
                  </div>
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <Label>PIN Fallback</Label>
                    </div>
                    <Switch
                      checked={settings.pin_fallback_enabled}
                      onCheckedChange={(checked) => setSettings({ ...settings, pin_fallback_enabled: checked })}
                    />
                  </div>
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <Label>Snapshot Audit</Label>
                    </div>
                    <Switch
                      checked={settings.snapshot_audit_enabled}
                      onCheckedChange={(checked) => setSettings({ ...settings, snapshot_audit_enabled: checked })}
                    />
                  </div>
                  <div className="md:col-span-2">
                    <Button disabled={loading} onClick={saveSettings} className="rounded-lg bg-emerald-600 hover:bg-emerald-700">
                      <Save className="h-4 w-4" />
                      Save Settings
                    </Button>
                  </div>
                </CardContent>
              </Card>
              <Card className="rounded-lg">
                <CardHeader className="p-4">
                  <CardTitle className="text-lg">Shifts</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 p-4 pt-0">
                  <div className="grid gap-3 rounded-lg border bg-slate-50 p-3 md:grid-cols-5">
                    <div className="space-y-2 md:col-span-2">
                      <Label>Shift Name</Label>
                      <Input
                        value={newShift.name}
                        onChange={(event) => setNewShift({ ...newShift, name: event.target.value })}
                        placeholder="Morning shift"
                        className="rounded-lg bg-white"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Start</Label>
                      <Input
                        value={newShift.shift_start}
                        onChange={(event) => setNewShift({ ...newShift, shift_start: event.target.value })}
                        type="time"
                        className="rounded-lg bg-white"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>End</Label>
                      <Input
                        value={newShift.shift_end}
                        onChange={(event) => setNewShift({ ...newShift, shift_end: event.target.value })}
                        type="time"
                        className="rounded-lg bg-white"
                      />
                    </div>
                    <div className="flex items-end">
                      <Button disabled={shiftSaving} onClick={createShift} className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-700">
                        Create Shift
                      </Button>
                    </div>
                    <div className="space-y-2">
                      <Label>Grace Minutes</Label>
                      <Input
                        value={newShift.grace_minutes}
                        onChange={(event) => setNewShift({ ...newShift, grace_minutes: event.target.value })}
                        type="number"
                        className="rounded-lg bg-white"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Overtime After Hours</Label>
                      <Input
                        value={newShift.overtime_after_hours}
                        onChange={(event) => setNewShift({ ...newShift, overtime_after_hours: event.target.value })}
                        type="number"
                        className="rounded-lg bg-white"
                      />
                    </div>
                  </div>

                  <div className="grid gap-3">
                    {shifts.map((shift) => (
                      <div key={shift.shift_id} className="grid gap-3 rounded-lg border p-3 lg:grid-cols-[1.4fr_120px_120px_120px_150px_auto_auto] lg:items-end">
                        <div className="space-y-2">
                          <Label>Name</Label>
                          <Input
                            value={shift.name}
                            onChange={(event) => setShifts((current) => current.map((item) => (
                              item.shift_id === shift.shift_id ? { ...item, name: event.target.value } : item
                            )))}
                            className="rounded-lg"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Start</Label>
                          <Input
                            value={shift.shift_start}
                            onChange={(event) => setShifts((current) => current.map((item) => (
                              item.shift_id === shift.shift_id ? { ...item, shift_start: event.target.value } : item
                            )))}
                            type="time"
                            className="rounded-lg"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>End</Label>
                          <Input
                            value={shift.shift_end}
                            onChange={(event) => setShifts((current) => current.map((item) => (
                              item.shift_id === shift.shift_id ? { ...item, shift_end: event.target.value } : item
                            )))}
                            type="time"
                            className="rounded-lg"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Grace</Label>
                          <Input
                            value={shift.grace_minutes}
                            onChange={(event) => setShifts((current) => current.map((item) => (
                              item.shift_id === shift.shift_id ? { ...item, grace_minutes: event.target.value } : item
                            )))}
                            type="number"
                            className="rounded-lg"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Overtime Hours</Label>
                          <Input
                            value={shift.overtime_after_hours}
                            onChange={(event) => setShifts((current) => current.map((item) => (
                              item.shift_id === shift.shift_id ? { ...item, overtime_after_hours: event.target.value } : item
                            )))}
                            type="number"
                            className="rounded-lg"
                          />
                        </div>
                        <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
                          <Switch
                            checked={shift.active !== false}
                            onCheckedChange={(checked) => setShifts((current) => current.map((item) => (
                              item.shift_id === shift.shift_id ? { ...item, active: checked } : item
                            )))}
                          />
                          <span className="text-sm font-medium">{shift.active !== false ? 'Active' : 'Inactive'}</span>
                        </div>
                        <Button
                          disabled={shiftSaving}
                          onClick={() => updateShift(shift, {})}
                          variant="outline"
                          className="rounded-lg"
                        >
                          Save
                        </Button>
                      </div>
                    ))}
                    {!shifts.length && (
                      <div className="rounded-lg border border-dashed p-6 text-center text-slate-500">
                        No shifts created yet.
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          )}
        </Tabs>
      </main>
    </div>
  );
};

const AttendanceDashboard = (props) => (
  <AttendanceErrorBoundary>
    <AttendanceDashboardContent {...props} />
  </AttendanceErrorBoundary>
);

export default AttendanceDashboard;
