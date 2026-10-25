import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, MotionConfig } from 'framer-motion';
import { IconChevronDown } from '@tabler/icons-react';

const ITEM_HEIGHT = 42;

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      when: 'beforeChildren',
      staggerChildren: 0.035,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: -8 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.25,
      ease: [0.25, 0.1, 0.25, 1],
    },
  },
};

function useClickAway(ref, handler) {
  useEffect(() => {
    const listener = (event) => {
      if (!ref.current || ref.current.contains(event.target)) return;
      handler(event);
    };

    document.addEventListener('mousedown', listener);
    document.addEventListener('touchstart', listener);

    return () => {
      document.removeEventListener('mousedown', listener);
      document.removeEventListener('touchstart', listener);
    };
  }, [ref, handler]);
}

function OptionIcon({ icon: Icon, isHovered, color }) {
  if (!Icon) return null;

  return (
    <motion.span
      className="select-option-icon"
      initial={false}
      animate={isHovered ? { scale: 1.2 } : { scale: 1 }}
    >
      <Icon size={16} stroke={1.75} />
      {isHovered && (
        <motion.span
          className="select-option-icon-overlay"
          style={{ color }}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.3, ease: 'easeInOut' }}
        >
          <Icon size={16} stroke={2} />
        </motion.span>
      )}
    </motion.span>
  );
}

export default function AnimatedDropdown({
  options,
  value,
  onChange,
  ariaLabel = 'Select an option',
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [hoveredId, setHoveredId] = useState(null);
  const dropdownRef = useRef(null);

  const selected = options.find((option) => option.id === value) || options[0];
  const activeId = hoveredId ?? selected.id;
  const highlightIndex = Math.max(
    0,
    options.findIndex((option) => option.id === activeId),
  );

  useClickAway(dropdownRef, () => setIsOpen(false));

  const handleKeyDown = (event) => {
    if (event.key === 'Escape') {
      setIsOpen(false);
      dropdownRef.current?.querySelector('.select-trigger')?.focus();
    }
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className="select-shell" ref={dropdownRef} onKeyDown={handleKeyDown}>
        <button
          type="button"
          className={`select-trigger${isOpen ? ' is-open' : ''}`}
          onClick={() => setIsOpen((open) => !open)}
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-label={`${ariaLabel}: ${selected.label}${selected.desc ? `, ${selected.desc}` : ''}`}
        >
          <span className="select-trigger-label">
            <OptionIcon icon={selected.icon} isHovered={false} color={selected.color} />
            <span className="select-trigger-text">{selected.label}</span>
          </span>
          <motion.span
            className="select-chevron"
            animate={{ rotate: isOpen ? 180 : 0 }}
            transition={{ duration: 0.2 }}
          >
            <IconChevronDown size={16} stroke={1.75} />
          </motion.span>
        </button>

        <AnimatePresence>
          {isOpen && (
            <motion.div
              className="select-menu"
              initial={{ opacity: 0, height: 0 }}
              animate={{
                opacity: 1,
                height: 'auto',
                transition: {
                  type: 'spring',
                  stiffness: 500,
                  damping: 30,
                  mass: 1,
                },
              }}
              exit={{
                opacity: 0,
                height: 0,
                transition: {
                  type: 'spring',
                  stiffness: 500,
                  damping: 30,
                  mass: 1,
                },
              }}
            >
              <motion.div
                className="select-menu-scroll"
                variants={containerVariants}
                initial="hidden"
                animate="visible"
              >
                <div className="select-menu-list" role="listbox" aria-label={ariaLabel}>
                  <motion.div
                    layoutId={`${ariaLabel}-hover-highlight`}
                    className="select-highlight"
                    initial={false}
                    animate={{ y: highlightIndex * ITEM_HEIGHT }}
                    transition={{
                      type: 'spring',
                      bounce: 0.15,
                      duration: 0.5,
                    }}
                  />

                  {options.map((option) => {
                    const isActive = option.id === activeId;
                    return (
                      <motion.button
                        key={option.id}
                        type="button"
                        role="option"
                        aria-selected={option.id === selected.id}
                        onClick={() => {
                          onChange(option.id);
                          setIsOpen(false);
                        }}
                        onHoverStart={() => setHoveredId(option.id)}
                        onHoverEnd={() => setHoveredId(null)}
                        onFocus={() => setHoveredId(option.id)}
                        onBlur={() => setHoveredId(null)}
                        className={`select-option${isActive ? ' is-active' : ''}`}
                        whileTap={{ scale: 0.98 }}
                        variants={itemVariants}
                      >
                        <OptionIcon
                          icon={option.icon}
                          isHovered={hoveredId === option.id}
                          color={option.color}
                        />
                        <span className="select-option-label">{option.label}</span>
                        {option.desc && <span className="select-option-desc">{option.desc}</span>}
                      </motion.button>
                    );
                  })}
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
