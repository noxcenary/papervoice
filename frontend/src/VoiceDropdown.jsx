import { IconGenderFemale, IconGenderMale } from '@tabler/icons-react';
import AnimatedDropdown from './AnimatedDropdown';

const REGION_COLORS = {
  'en-US': '#FF6B6B',
  'en-GB': '#4ECDC4',
  'en-IN': '#F9C74F',
  'en-AU': '#45B7D1',
};

export default function VoiceDropdown({ voices, value, onChange }) {
  const options = voices.map((voice) => {
    const isFemale = voice.label.includes('Female');
    const region = voice.id.split('-').slice(0, 2).join('-');
    return {
      ...voice,
      icon: isFemale ? IconGenderFemale : IconGenderMale,
      color: REGION_COLORS[region] || '#A06CD5',
    };
  });

  return (
    <AnimatedDropdown
      options={options}
      value={value}
      onChange={onChange}
      ariaLabel="Voice"
    />
  );
}
