import Hero from './components/Hero';
import Showcase from './components/Showcase';
import Features from './components/Features';
import HowItWorks from './components/HowItWorks';
import Footer from './components/Footer';

export default function App() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 antialiased">
      <main>
        <Hero />
        <Showcase />
        <Features />
        <HowItWorks />
      </main>
      <Footer />
    </div>
  );
}
