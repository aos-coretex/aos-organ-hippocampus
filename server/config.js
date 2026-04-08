/**
 * Hippocampus configuration — environment-driven, AOS/SAAS aware.
 */

const env = process.env.NODE_ENV || 'development';
const isAOS = env !== 'production';

export default {
  name: 'Hippocampus',
  port: parseInt(process.env.HIPPOCAMPUS_PORT || (isAOS ? '4008' : '3908'), 10),
  binding: '127.0.0.1',
  spineUrl: process.env.SPINE_URL || (isAOS ? 'http://127.0.0.1:4000' : 'http://127.0.0.1:3900'),
  vectrUrl: process.env.VECTR_URL || (isAOS ? 'http://127.0.0.1:4001' : 'http://127.0.0.1:3901'),
  graphUrl: process.env.GRAPH_URL || (isAOS ? 'http://127.0.0.1:4020' : 'http://127.0.0.1:3920'),
  phiUrl: process.env.PHI_URL || (isAOS ? 'http://127.0.0.1:4005' : 'http://127.0.0.1:3905'),
  env,
};
