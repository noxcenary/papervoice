import { IconBolt, IconGauge, IconWalk } from '@tabler/icons-react';
import AnimatedDropdown from './AnimatedDropdown';

const SPEED_OPTIONS = [
  { id: -20, label: 'Slow', desc: 'slower pace', icon: IconWalk, color: '#45B7D1' },
  { id: 0, label: 'Normal', desc: 'natural pace', icon: IconGauge, color: '#A06CD5' },
  { id: 20, label: 'Fast', desc: 'quicker pace', icon: IconBolt, color: '#FF6B6B' },
];

export default function SpeedDropdown({ value, onChange }) {
  return (
    <AnimatedDropdown
      options={SPEED_OPTIONS}
      value={value}
      onChange={onChange}
      ariaLabel="Speed"
    />
  );
}
